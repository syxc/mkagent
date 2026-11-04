import type { ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export interface PiWorkerSink {
  ownerSessionId: string;
  onLine(line: string): void;
  onStderr(text: string): void;
  onError(error: Error): void;
  onExit(code: number | null, signal: string | null): void;
}

export interface PiWorkerLease {
  readonly ownerSessionId: string;
  readonly generation: number;
  send(command: Record<string, unknown>): boolean;
  cancelBackgroundStop(requestId: string): void;
  /** Release foreground ownership; known shells and pending stop replies still drain. */
  release(): void;
}

interface WorkerBinding {
  generation: number;
  ownerSessionId: string;
  sink: PiWorkerSink;
  backgroundTasks: Set<string>;
  pendingStops: Set<string>;
  transferPins: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Owns process I/O so a foreground binding can change without replacing its process. */
export class PiWorkerConnection {
  private reader: ReadlineInterface;
  private binding: WorkerBinding | undefined;
  private bindings = new Map<number, WorkerBinding>();
  private leases = new WeakMap<PiWorkerLease, WorkerBinding>();
  private generation = 0;
  private closed = false;
  private closing = false;
  private shutdownScheduled = false;
  private terminationTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly child: ChildProcess) {
    if (!child.stdout) throw new Error('Pi worker stdout must be piped');
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', this.onLine);
    child.stdin?.on('error', this.onError);
    child.stderr?.on('data', this.onStderr);
    child.on('error', this.onError);
    child.on('exit', this.onExit);
    child.once('close', this.onClose);
  }

  bind(sink: PiWorkerSink): PiWorkerLease {
    this.assertOpen();
    if (!sink.ownerSessionId) throw new Error('Pi worker binding requires a product session ID');
    const previous = this.binding;
    const generation = ++this.generation;
    const ownerSessionId = sink.ownerSessionId;
    const binding: WorkerBinding = {
      generation, ownerSessionId, sink, backgroundTasks: new Set(), pendingStops: new Set(), transferPins: 0,
    };
    this.binding = binding;
    this.bindings.set(generation, binding);
    if (previous) this.prune(previous);
    const lease: PiWorkerLease = {
      ownerSessionId,
      generation,
      send: command => {
        if (!this.isOpen()) return false;
        const stop = command.type === 'stop_background_task' &&
          typeof command.taskId === 'string' && typeof command.id === 'string' && command.id.length > 0
          ? { taskId: command.taskId, id: command.id } : undefined;
        if (this.binding !== binding && (!stop || !binding.backgroundTasks.has(stop.taskId))) return false;
        if (stop && binding.pendingStops.has(stop.id)) return false;
        const line = JSON.stringify({
          ...command, ownerSessionId, runtimeGeneration: generation,
        }) + '\n';
        if (stop) binding.pendingStops.add(stop.id);
        try {
          this.child.stdin!.write(line, error => {
            if (!error || !stop) return;
            binding.pendingStops.delete(stop.id);
            this.prune(binding);
          });
          return true;
        } catch {
          if (stop) binding.pendingStops.delete(stop.id);
          this.prune(binding);
          return false;
        }
      },
      cancelBackgroundStop: requestId => {
        binding.pendingStops.delete(requestId);
        this.prune(binding);
      },
      release: () => {
        if (this.binding === binding) this.binding = undefined;
        this.prune(binding);
      },
    };
    this.leases.set(lease, binding);
    return lease;
  }

  /** Pin before releasing the source lease; release the pin after target bind or abort. */
  holdTransfer(lease: PiWorkerLease): () => void {
    this.assertOpen();
    const binding = this.leases.get(lease);
    if (!binding || this.binding !== binding) throw new Error('Pi worker transfer requires its active lease');
    binding.transferPins++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      binding.transferPins--;
      this.prune(binding);
    };
  }

  /** Detach all I/O without stopping the child. Shared owners must release their lease instead. */
  close(): void {
    this.closed = true;
    clearTimeout(this.terminationTimer);
    this.terminationTimer = undefined;
    this.binding = undefined;
    this.bindings.clear();
    this.reader.removeListener('line', this.onLine);
    this.reader.close();
    this.child.stderr?.removeListener('data', this.onStderr);
    // A child may still emit an error while shutting down, before its close event.
  }

  private onLine = (line: string): void => {
    let binding = this.binding;
    let message: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        message = parsed;
        const scoped = Object.hasOwn(message, 'ownerSessionId') || Object.hasOwn(message, 'runtimeGeneration');
        if (scoped) {
          if (typeof message.runtimeGeneration !== 'number') return;
          binding = this.bindings.get(message.runtimeGeneration);
          if (!binding || message.ownerSessionId !== binding.ownerSessionId) return;
        } else if (!binding || binding.generation > 1) {
          // An unscoped message cannot identify its owner after a foreground transfer.
          return;
        }
      } else if (!binding || binding.generation > 1) return;
    } catch {
      // Preserve the current host's diagnostic for invalid JSONL.
      if (!binding || binding.generation > 1) return;
    }
    if (!binding) return;
    const active = this.binding === binding;
    const event = message?.type === 'background_task_event' && isRecord(message.event) ? message.event : undefined;
    const completion = event?.type === 'task_completed' && typeof event.taskId === 'string' &&
      binding.backgroundTasks.has(event.taskId) ? event.taskId : undefined;
    const stopReply = message?.type === 'stop_background_task_result' && typeof message.id === 'string' &&
      binding.pendingStops.has(message.id) ? message.id : undefined;
    if (!active && !completion && !stopReply) return;
    if (active && event?.type === 'shell_backgrounded' && typeof event.shellId === 'string' && event.shellId) {
      binding.backgroundTasks.add(event.shellId);
    }
    if (completion) binding.backgroundTasks.delete(completion);
    if (stopReply) binding.pendingStops.delete(stopReply);
    try { binding.sink.onLine(line); } finally { this.prune(binding); }
  };

  private prune(binding: WorkerBinding): void {
    if (this.binding !== binding && binding.backgroundTasks.size === 0 &&
      binding.pendingStops.size === 0 && binding.transferPins === 0) {
      this.bindings.delete(binding.generation);
    }
    this.shutdownIfUnused();
  }

  private isOpen(): boolean {
    return !this.closed && !this.closing && this.child.exitCode === null &&
      this.child.signalCode === null && !this.child.killed && Boolean(this.child.stdin?.writable);
  }

  private assertOpen(): void {
    if (!this.isOpen()) throw new Error('Pi worker connection is closed');
  }

  private isUnused(): boolean {
    return !this.binding && this.bindings.size === 0;
  }

  private shutdownIfUnused(): void {
    if (this.closed || this.closing || this.shutdownScheduled || !this.isUnused()) return;
    this.shutdownScheduled = true;
    // Preserve synchronous rebinding; transfers across an await must hold a pin.
    queueMicrotask(() => {
      this.shutdownScheduled = false;
      if (this.closed || this.closing || !this.isUnused()) return;
      this.closing = true;
      // EOF is process-wide and does not borrow a retired owner's command scope.
      try { this.child.stdin?.end(); } catch { /* Signal escalation still applies. */ }
      this.scheduleTermination('SIGTERM', 2_000);
    });
  }

  private scheduleTermination(signal: 'SIGTERM' | 'SIGKILL', delayMs: number): void {
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = undefined;
      // Timers belong to this physical connection and must never outlive its references.
      if (this.closed || !this.closing || !this.isUnused() ||
        this.child.exitCode !== null || this.child.signalCode !== null) return;
      try { this.child.kill(signal); } catch { /* The child may already have exited. */ }
      if (signal === 'SIGTERM' && !this.closed) this.scheduleTermination('SIGKILL', 1_000);
    }, delayMs);
    this.terminationTimer.unref();
  }

  private onStderr = (chunk: Buffer): void => { this.binding?.sink.onStderr(chunk.toString()); };
  private onError = (error: Error): void => {
    const sinks = new Set([...this.bindings.values()].map(binding => binding.sink));
    for (const sink of sinks) sink.onError(error);
  };
  private onExit = (code: number | null, signal: string | null): void => {
    const sinks = new Set([...this.bindings.values()].map(binding => binding.sink));
    this.close();
    for (const sink of sinks) sink.onExit(code, signal);
  };
  private onClose = (code: number | null, signal: string | null): void => {
    // Spawn failures can close without exit; notify only bindings on this connection.
    if (!this.closed) this.onExit(code, signal);
    this.child.stdin?.removeListener('error', this.onError);
    this.child.removeListener('error', this.onError);
    this.child.removeListener('exit', this.onExit);
  };
}

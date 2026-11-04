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
  release(): void;
}

interface WorkerBinding {
  generation: number;
  ownerSessionId: string;
  sink: PiWorkerSink;
  backgroundTasks: Set<string>;
  pendingStops: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Owns process I/O so a foreground binding can change without replacing its process. */
export class PiWorkerConnection {
  private reader: ReadlineInterface;
  private binding: WorkerBinding | undefined;
  private bindings = new Map<number, WorkerBinding>();
  private generation = 0;
  private closed = false;

  constructor(readonly child: ChildProcess) {
    if (!child.stdout) throw new Error('Pi worker stdout must be piped');
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', this.onLine);
    child.stderr?.on('data', this.onStderr);
    child.on('error', this.onError);
    child.on('exit', this.onExit);
    child.once('close', this.onClose);
  }

  bind(sink: PiWorkerSink): PiWorkerLease {
    if (this.closed) throw new Error('Pi worker connection is closed');
    if (!sink.ownerSessionId) throw new Error('Pi worker binding requires a product session ID');
    const previous = this.binding;
    const generation = ++this.generation;
    const ownerSessionId = sink.ownerSessionId;
    const binding: WorkerBinding = { generation, ownerSessionId, sink, backgroundTasks: new Set(), pendingStops: new Set() };
    this.binding = binding;
    this.bindings.set(generation, binding);
    if (previous) this.prune(previous);
    return {
      ownerSessionId,
      generation,
      send: command => {
        if (this.closed || !this.child.stdin?.writable) return false;
        const stop = command.type === 'stop_background_task' &&
          typeof command.taskId === 'string' && typeof command.id === 'string' && command.id.length > 0
          ? { taskId: command.taskId, id: command.id } : undefined;
        if (this.binding !== binding && (!stop || !binding.backgroundTasks.has(stop.taskId))) return false;
        if (stop) {
          if (binding.pendingStops.has(stop.id)) return false;
          binding.pendingStops.add(stop.id);
        }
        this.child.stdin.write(JSON.stringify({
          ...command, ownerSessionId, runtimeGeneration: generation,
        }) + '\n');
        return true;
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
  }

  close(): void {
    this.closed = true;
    this.binding = undefined;
    this.bindings.clear();
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
    if (this.binding !== binding && binding.backgroundTasks.size === 0 && binding.pendingStops.size === 0) {
      this.bindings.delete(binding.generation);
    }
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
  private onClose = (): void => {
    this.close();
    this.child.removeListener('error', this.onError);
    this.child.removeListener('exit', this.onExit);
  };
}

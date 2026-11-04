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
  readonly generation: number;
  send(command: Record<string, unknown>): boolean;
  release(): void;
}

/** Owns process I/O so a foreground binding can change without replacing its process. */
export class PiWorkerConnection {
  private reader: ReadlineInterface;
  private binding: { generation: number; sink: PiWorkerSink } | undefined;
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
    const generation = ++this.generation;
    this.binding = { generation, sink };
    return {
      generation,
      send: command => {
        if (this.binding?.generation !== generation || !this.child.stdin?.writable) return false;
        this.child.stdin.write(JSON.stringify({
          ...command, ownerSessionId: sink.ownerSessionId, runtimeGeneration: generation,
        }) + '\n');
        return true;
      },
      release: () => {
        if (this.binding?.generation === generation) this.binding = undefined;
      },
    };
  }

  close(): void {
    this.closed = true;
    this.binding = undefined;
    this.reader.close();
    this.child.stderr?.removeListener('data', this.onStderr);
    // A child may still emit an error while shutting down, before its close event.
  }

  private onLine = (line: string): void => {
    const binding = this.binding;
    if (!binding) return;
    try {
      const message = JSON.parse(line);
      if (message && typeof message === 'object') {
        const scoped = Object.hasOwn(message, 'ownerSessionId') || Object.hasOwn(message, 'runtimeGeneration');
        if (scoped) {
          if (message.ownerSessionId !== binding.sink.ownerSessionId ||
              message.runtimeGeneration !== binding.generation) return;
        } else if (binding.generation > 1) {
          // An unscoped message cannot identify its owner after a foreground transfer.
          return;
        }
      } else if (binding.generation > 1) return;
    } catch {
      // Preserve the current host's diagnostic for invalid JSONL.
      if (binding.generation > 1) return;
    }
    binding.sink.onLine(line);
  };

  private onStderr = (chunk: Buffer): void => { this.binding?.sink.onStderr(chunk.toString()); };
  private onError = (error: Error): void => { this.binding?.sink.onError(error); };
  private onExit = (code: number | null, signal: string | null): void => {
    const sink = this.binding?.sink;
    this.close();
    sink?.onExit(code, signal);
  };
  private onClose = (): void => {
    this.close();
    this.child.removeListener('error', this.onError);
    this.child.removeListener('exit', this.onExit);
  };
}

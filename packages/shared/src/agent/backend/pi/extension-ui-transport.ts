/** Carry native plugin UI independently from chat events and tool permissions. */
import {
  isExtensionUIEvent,
  type ExtensionUIConnection, type ExtensionUIHostPort, type ExtensionUIResponse,
} from '../../../protocol/extension-ui.ts';

export class PiExtensionUITransport {
  private readonly connection?: ExtensionUIConnection;
  private readonly pending = new Map<string, { resolve(accepted: boolean): void; timer: ReturnType<typeof setTimeout> }>();
  private disposed = false;
  private _available = false;

  get available(): boolean { return this._available; }

  constructor(port: ExtensionUIHostPort | undefined, private readonly send: (command: Record<string, unknown>) => boolean) {
    this.connection = port?.connect({
      setAvailable: available => {
        if (this.disposed || this.available === available) return;
        this._available = available;
        this.send({ type: 'extension_ui_available', available });
      },
      respond: (uiEpoch, response) => this.respond(uiEpoch, response),
    });
  }

  handleMessage(message: Record<string, unknown>): boolean {
    if (message.type === 'extension_ui_response_result') {
      if (typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message.accepted === true);
        }
      }
      return true;
    }
    if (message.type !== 'extension_ui_request' && message.type !== 'extension_ui_closed' && message.type !== 'extension_ui_state') return false;
    if (!this.disposed && isExtensionUIEvent(message)) {
      if (message.type === 'extension_ui_state' && message.reset) this.clearPending();
      this.connection?.event(message);
    }
    return true;
  }

  reset(): void {
    if (this.disposed) return;
    this.clearPending();
    this.connection?.reset();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPending();
    this.connection?.close();
  }

  private respond(uiEpoch: string, response: ExtensionUIResponse): Promise<boolean> {
    if (this.disposed || !this.available) return Promise.resolve(false);
    const responseId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(responseId);
        resolve(false);
      }, 5_000);
      this.pending.set(responseId, { resolve, timer });
      if (!this.send({ ...response, uiEpoch, responseId })) {
        clearTimeout(timer);
        this.pending.delete(responseId);
        resolve(false);
      }
    });
  }

  private clearPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pending.clear();
  }
}

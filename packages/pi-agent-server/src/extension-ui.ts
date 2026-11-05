/** Scope native RPC UI requests to one worker initialization and one native session. */
import { randomUUID } from 'node:crypto';
import type {
  ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions,
  ProjectTrustContext, RpcExtensionUIRequest, RpcExtensionUIResponse,
} from '@mkagent/pi-durable-coding/native';

export type ExtensionUIEvent =
  | (RpcExtensionUIRequest & { uiEpoch: string })
  | { type: 'extension_ui_closed'; uiEpoch: string; id: string }
  | { type: 'extension_ui_state'; uiEpoch: string; available: boolean; reset: boolean };

type RpcUIContext = Pick<ExtensionUIContext,
  'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget'
  | 'setTitle' | 'setEditorText' | 'pasteToEditor'>;

export interface ExtensionUIBinding<Context = ExtensionUIContext> {
  readonly context: Context;
  readonly available: boolean;
  close(): void;
}

/** Keep transport availability and abort suspension across native session reloads. */
export class ExtensionUIHost {
  private binding?: NativeUIBinding<object>;
  private available = false;
  private suspended = 0;
  private closed = false;

  constructor(private readonly emit: (event: ExtensionUIEvent) => void) {}

  bind<Context extends object>(fallback: Context,
    onAvailability: (available: boolean) => void): ExtensionUIBinding<Context & RpcUIContext> {
    this.binding?.close();
    const binding = new NativeUIBinding(fallback, this.enabled(), onAvailability, this.emit);
    this.binding = binding;
    return binding;
  }

  projectTrustContext(cwd: string): ProjectTrustContext {
    return {
      cwd, mode: this.binding?.available ? 'rpc' : 'print', hasUI: this.binding?.available ?? false,
      ui: this.binding?.context ?? {
        select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {},
      },
    };
  }

  setAvailable(available: boolean): void {
    this.available = available;
    this.binding?.setAvailable(this.enabled());
  }

  respond(uiEpoch: string, response: RpcExtensionUIResponse): boolean {
    return this.binding?.respond(uiEpoch, response) ?? false;
  }

  suspend(): () => void {
    this.suspended++;
    this.binding?.setAvailable(false);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspended--;
      this.binding?.setAvailable(this.enabled());
    };
  }

  close(): void {
    this.closed = true;
    this.binding?.close();
  }

  private enabled(): boolean { return !this.closed && this.available && this.suspended === 0; }
}

type DialogRequest = Extract<RpcExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }>;
const stringResponse = (response: RpcExtensionUIResponse): string | undefined =>
  'value' in response ? response.value : undefined;

class NativeUIBinding<Context extends object> implements ExtensionUIBinding<Context & RpcUIContext> {
  readonly context: Context & RpcUIContext;
  private readonly uiEpoch = randomUUID();
  private readonly pending = new Map<string, {
    request: DialogRequest;
    finish(response?: RpcExtensionUIResponse): void;
  }>();
  private closed = false;

  constructor(
    fallback: Context,
    public available: boolean,
    private readonly onAvailability: (available: boolean) => void,
    private readonly emit: (event: ExtensionUIEvent) => void,
  ) {
    // Inherit native no-op behavior for features the upstream RPC mode cannot render.
    this.context = {
      ...fallback,
      select: (title, options, opts) => this.dialog({
        type: 'extension_ui_request', id: randomUUID(), method: 'select', title, options, timeout: opts?.timeout,
      }, undefined, stringResponse, opts),
      confirm: (title, message, opts) => this.dialog({
        type: 'extension_ui_request', id: randomUUID(), method: 'confirm', title, message, timeout: opts?.timeout,
      }, false, response => 'confirmed' in response ? response.confirmed : false, opts),
      input: (title, placeholder, opts) => this.dialog({
        type: 'extension_ui_request', id: randomUUID(), method: 'input', title, placeholder, timeout: opts?.timeout,
      }, undefined, stringResponse, opts),
      editor: (title, prefill) => this.dialog({
        type: 'extension_ui_request', id: randomUUID(), method: 'editor', title, prefill,
      }, undefined, stringResponse),
      notify: (message, notifyType) => this.publish({
        type: 'extension_ui_request', id: randomUUID(), method: 'notify', message, notifyType,
      }),
      setStatus: (statusKey, statusText) => this.publish({
        type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey, statusText,
      }),
      setWidget: (widgetKey: string, content: unknown, options?: ExtensionWidgetOptions) => {
        // The wire contract carries lines; terminal component factories stay unsupported.
        if (content === undefined || (Array.isArray(content) && content.every(line => typeof line === 'string'))) {
          this.publish({ type: 'extension_ui_request', id: randomUUID(), method: 'setWidget',
            widgetKey, widgetLines: content, widgetPlacement: options?.placement });
        }
      },
      setTitle: title => this.publish({ type: 'extension_ui_request', id: randomUUID(), method: 'setTitle', title }),
      setEditorText: text => this.publish({
        type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', text,
      }),
      pasteToEditor: text => this.context.setEditorText(text),
    };
    this.emit({ type: 'extension_ui_state', uiEpoch: this.uiEpoch, available, reset: true });
  }

  setAvailable(available: boolean): void {
    const next = available && !this.closed;
    if (this.available === next) return;
    this.available = next;
    if (!next) this.cancelPending();
    this.onAvailability(next);
    this.emit({ type: 'extension_ui_state', uiEpoch: this.uiEpoch, available: next, reset: false });
  }

  respond(uiEpoch: string, response: RpcExtensionUIResponse): boolean {
    if (uiEpoch !== this.uiEpoch || !this.available || this.closed) return false;
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    // Responses arrive from another process; reject the wrong kind or an invented choice.
    const cancelled = 'cancelled' in response && response.cancelled === true;
    if (!cancelled) {
      if (pending.request.method === 'confirm') {
        if (!('confirmed' in response) || typeof response.confirmed !== 'boolean') return false;
      } else {
        if (!('value' in response) || typeof response.value !== 'string') return false;
        if (pending.request.method === 'select' && !pending.request.options.includes(response.value)) return false;
      }
    }
    pending.finish(cancelled ? undefined : response);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.available = false;
    this.cancelPending();
    this.onAvailability(false);
    this.emit({ type: 'extension_ui_state', uiEpoch: this.uiEpoch, available: false, reset: true });
  }

  private dialog<T>(
    request: DialogRequest, fallback: T, parse: (response: RpcExtensionUIResponse) => T,
    options?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (!this.available || this.closed || options?.signal?.aborted) return Promise.resolve(fallback);
    const result = Promise.withResolvers<T>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: RpcExtensionUIResponse) => {
      if (!this.pending.delete(request.id)) return;
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
      result.resolve(response ? parse(response) : fallback);
      this.emit({ type: 'extension_ui_closed', uiEpoch: this.uiEpoch, id: request.id });
    };
    const onAbort = () => finish();
    this.pending.set(request.id, { request, finish });
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (options?.timeout) timer = setTimeout(onAbort, options.timeout);
    this.emit({ ...request, uiEpoch: this.uiEpoch });
    return result.promise;
  }

  private cancelPending(): void {
    for (const pending of [...this.pending.values()]) pending.finish();
  }

  private publish(request: RpcExtensionUIRequest): void {
    const persistent = request.method === 'setStatus' || request.method === 'setWidget' || request.method === 'setTitle';
    if (!this.closed && (this.available || persistent)) this.emit({ ...request, uiEpoch: this.uiEpoch });
  }
}

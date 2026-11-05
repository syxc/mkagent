/** Native extension UI contracts shared by the worker, product owner and clients. */
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '@mkagent/pi-durable-coding/rpc-ui';

export type ExtensionUIResponse = RpcExtensionUIResponse;
export type ExtensionUIEvent =
  | (RpcExtensionUIRequest & { uiEpoch: string; sensitive?: boolean })
  | { type: 'extension_ui_closed'; uiEpoch: string; id: string }
  | { type: 'extension_ui_state'; uiEpoch: string; available: boolean; reset: boolean };

export type ExtensionUIDialog = Extract<ExtensionUIEvent,
  { type: 'extension_ui_request'; method: 'select' | 'confirm' | 'input' | 'editor' }>;

export interface ExtensionUISnapshot {
  sessionId: string;
  revision: number;
  uiEpoch: string | null;
  available: boolean;
  requests: ExtensionUIDialog[];
  statuses: Array<{ key: string; text: string }>;
  widgets: Array<{ key: string; lines: string[]; placement?: 'aboveEditor' | 'belowEditor' }>;
  title?: string;
}

export interface ExtensionUIUpdate {
  /** A client supplies a fresh lease on reconnect, so buffered transient effects cannot replay. */
  subscriptionId: string;
  snapshot: ExtensionUISnapshot;
  /** Transient effects must not be replayed from a reconnect snapshot. */
  effect?: Extract<ExtensionUIEvent, { type: 'extension_ui_request'; method: 'notify' | 'set_editor_text' }>;
}

export interface ExtensionUIController {
  setAvailable(available: boolean): void;
  respond(uiEpoch: string, response: ExtensionUIResponse): Promise<boolean>;
}

export interface ExtensionUIConnection {
  event(event: ExtensionUIEvent): void;
  reset(): void;
  close(): void;
}

/** A connection keeps a retired backend from changing its successor's UI state. */
export interface ExtensionUIHostPort {
  connect(controller: ExtensionUIController): ExtensionUIConnection;
}

/** Validate the JSONL boundary before forwarding plugin data into product UI. */
export function isExtensionUIEvent(value: Record<string, unknown>): value is Record<string, unknown> & ExtensionUIEvent {
  if (typeof value.uiEpoch !== 'string' || !value.uiEpoch) return false;
  if (value.type === 'extension_ui_state') return typeof value.available === 'boolean' && typeof value.reset === 'boolean';
  if (value.type === 'extension_ui_closed') return typeof value.id === 'string';
  if (value.type !== 'extension_ui_request' || typeof value.id !== 'string') return false;
  if ('timeout' in value && value.timeout !== undefined && typeof value.timeout !== 'number') return false;
  switch (value.method) {
    case 'select':
      return typeof value.title === 'string' && Array.isArray(value.options) && value.options.every(option => typeof option === 'string');
    case 'confirm': return typeof value.title === 'string' && typeof value.message === 'string';
    case 'input': return typeof value.title === 'string'
      && (value.placeholder === undefined || typeof value.placeholder === 'string')
      && (value.sensitive === undefined || typeof value.sensitive === 'boolean');
    case 'editor': return typeof value.title === 'string' && (value.prefill === undefined || typeof value.prefill === 'string');
    case 'notify':
      return typeof value.message === 'string' &&
        (value.notifyType === undefined || value.notifyType === 'info' || value.notifyType === 'warning' || value.notifyType === 'error');
    case 'setStatus':
      return typeof value.statusKey === 'string' && (value.statusText === undefined || typeof value.statusText === 'string');
    case 'setWidget':
      return typeof value.widgetKey === 'string' &&
        (value.widgetLines === undefined || (Array.isArray(value.widgetLines) && value.widgetLines.every(line => typeof line === 'string'))) &&
        (value.widgetPlacement === undefined || value.widgetPlacement === 'aboveEditor' || value.widgetPlacement === 'belowEditor');
    case 'setTitle': return typeof value.title === 'string';
    case 'set_editor_text': return typeof value.text === 'string';
    default: return false;
  }
}

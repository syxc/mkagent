import type {
  ExtensionUIConnection,
  ExtensionUIController,
  ExtensionUIDialog,
  ExtensionUIEvent,
  ExtensionUIHostPort,
  ExtensionUIResponse,
  ExtensionUISnapshot,
  ExtensionUIUpdate,
} from '@mkagent/shared/protocol'

interface SessionUI {
  sessionId: string
  revision: number
  uiEpoch: string | null
  available: boolean
  clients: Map<string, string>
  controller?: ExtensionUIController
  lease?: symbol
  requests: Map<string, ExtensionUIDialog>
  responding: Set<ExtensionUIDialog>
  statuses: Map<string, string>
  widgets: Map<string, { lines: string[]; placement?: 'aboveEditor' | 'belowEditor' }>
  title?: string
}

function parseResponse(dialog: ExtensionUIDialog, value: unknown): ExtensionUIResponse | undefined {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'extension_ui_response'
    || !('id' in value) || value.id !== dialog.id) return
  if ('cancelled' in value) return value.cancelled === true
    ? { type: 'extension_ui_response', id: dialog.id, cancelled: true } : undefined
  if (dialog.method === 'confirm') {
    if ('confirmed' in value && typeof value.confirmed === 'boolean') {
      return { type: 'extension_ui_response', id: dialog.id, confirmed: value.confirmed }
    }
  } else if ('value' in value && typeof value.value === 'string'
    && (dialog.method !== 'select' || dialog.options.includes(value.value))) {
    return { type: 'extension_ui_response', id: dialog.id, value: value.value }
  }
}

/** Product ownership and client leases stay outside the native worker's UI epoch. */
export class SessionExtensionUI {
  private readonly sessions = new Map<string, SessionUI>()

  constructor(private readonly send: (clientId: string, update: ExtensionUIUpdate) => void) {}

  private session(sessionId: string): SessionUI {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = {
        sessionId, revision: 0, uiEpoch: null, available: false,
        clients: new Map(), requests: new Map(), responding: new Set(), statuses: new Map(), widgets: new Map(),
      }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private snapshot(session: SessionUI): ExtensionUISnapshot {
    return {
      sessionId: session.sessionId, revision: session.revision, uiEpoch: session.uiEpoch,
      available: session.available,
      requests: [...session.requests.values()].map(request => request.method === 'select'
        ? { ...request, options: [...request.options] } : { ...request }),
      statuses: [...session.statuses].map(([key, text]) => ({ key, text })),
      widgets: [...session.widgets].map(([key, widget]) => ({ key, lines: [...widget.lines], placement: widget.placement })),
      title: session.title,
    }
  }

  private publish(session: SessionUI, effect?: ExtensionUIUpdate['effect']): void {
    session.revision++
    const snapshot = this.snapshot(session)
    for (const [clientId, subscriptionId] of session.clients) {
      this.send(clientId, { subscriptionId, snapshot, ...(effect ? { effect } : {}) })
    }
  }

  private reset(session: SessionUI): void {
    session.uiEpoch = null
    session.available = false
    session.requests.clear()
    session.responding.clear()
    session.statuses.clear()
    session.widgets.clear()
    session.title = undefined
    this.publish(session)
  }

  port(sessionId: string): ExtensionUIHostPort {
    const session = this.session(sessionId)
    return { connect: controller => {
      if (this.sessions.get(sessionId) !== session) {
        controller.setAvailable(false)
        return { event() {}, reset() {}, close() {} }
      }
      const old = session.controller
      const lease = Symbol(sessionId)
      session.controller = controller
      session.lease = lease
      old?.setAvailable(false)
      this.reset(session)
      const current = () => this.sessions.get(sessionId) === session && session.lease === lease
      controller.setAvailable(session.clients.size > 0)
      const connection: ExtensionUIConnection = {
        event: event => { if (current()) this.event(session, event) },
        reset: () => { if (current()) this.reset(session) },
        close: () => {
          if (!current()) return
          session.controller = undefined
          session.lease = undefined
          this.reset(session)
        },
      }
      return connection
    } }
  }

  attach(sessionId: string, clientId: string, subscriptionId: string): ExtensionUISnapshot {
    if (!clientId || typeof subscriptionId !== 'string' || !subscriptionId || subscriptionId.length > 128) {
      throw new Error('Invalid extension UI subscription')
    }
    const session = this.session(sessionId)
    session.clients.set(clientId, subscriptionId)
    session.controller?.setAvailable(true)
    return this.snapshot(session)
  }

  detach(sessionId: string, clientId: string, subscriptionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.clients.get(clientId) !== subscriptionId) return
    session.clients.delete(clientId)
    if (!session.clients.size) {
      session.available = false
      session.requests.clear()
      session.controller?.setAvailable(false)
      this.publish(session)
    }
  }

  disconnect(clientId: string): void {
    for (const session of this.sessions.values()) {
      const subscriptionId = session.clients.get(clientId)
      if (subscriptionId) this.detach(session.sessionId, clientId, subscriptionId)
    }
  }

  async respond(sessionId: string, clientId: string, subscriptionId: string, uiEpoch: string,
    value: unknown): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session?.available || typeof subscriptionId !== 'string' || !subscriptionId
      || !session.clients.has(clientId) || session.clients.get(clientId) !== subscriptionId
      || session.uiEpoch !== uiEpoch || !session.controller || !value || typeof value !== 'object'
      || !('id' in value) || typeof value.id !== 'string') return false
    const dialog = session.requests.get(value.id)
    if (!dialog || session.responding.has(dialog)) return false
    const response = parseResponse(dialog, value)
    if (!response) return false
    const controller = session.controller
    const lease = session.lease
    session.responding.add(dialog)
    try {
      const accepted = await controller.respond(uiEpoch, response)
      return accepted && this.sessions.get(sessionId) === session && session.lease === lease
        && session.uiEpoch === uiEpoch && session.clients.get(clientId) === subscriptionId
    } catch {
      return false
    } finally {
      session.responding.delete(dialog)
    }
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    const controller = session.controller
    session.controller = undefined
    session.lease = undefined
    this.reset(session)
    controller?.setAvailable(false)
  }

  clear(): void {
    for (const sessionId of this.sessions.keys()) this.remove(sessionId)
  }

  private event(session: SessionUI, event: ExtensionUIEvent): void {
    if (event.type === 'extension_ui_state') {
      if (event.reset) this.reset(session)
      else if (session.uiEpoch !== event.uiEpoch) return
      session.uiEpoch = event.uiEpoch
      session.available = event.available && session.clients.size > 0
      if (!session.available) session.requests.clear()
      this.publish(session)
      return
    }
    if (event.uiEpoch !== session.uiEpoch) return
    if (event.type === 'extension_ui_closed') {
      if (session.requests.delete(event.id)) this.publish(session)
      return
    }
    switch (event.method) {
      case 'select': case 'confirm': case 'input': case 'editor':
        if (session.available) session.requests.set(event.id, event)
        break
      case 'notify': case 'set_editor_text':
        this.publish(session, event)
        return
      case 'setStatus':
        if (event.statusText === undefined) session.statuses.delete(event.statusKey)
        else session.statuses.set(event.statusKey, event.statusText)
        break
      case 'setWidget':
        if (event.widgetLines === undefined) session.widgets.delete(event.widgetKey)
        else session.widgets.set(event.widgetKey, { lines: [...event.widgetLines], placement: event.widgetPlacement })
        break
      case 'setTitle': session.title = event.title
    }
    this.publish(session)
  }
}

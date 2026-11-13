export interface InputOriginLease {
  readonly clientId: string
  isCurrent(): boolean
  release(): void
}

interface InputOrigin {
  sessionId: string
  clientId: string
  claims: number
  settled: boolean
}

/** Caller provenance is transient; a live owner transaction can retain a settled input. */
export class InputOrigins {
  private readonly inputs = new Map<string, InputOrigin>()

  admit(sessionId: string, inputId: string, clientId: string): void {
    this.inputs.set(inputId, { sessionId, clientId, claims: 0, settled: false })
  }

  claim(sessionId: string, inputId: string): InputOriginLease | undefined {
    const origin = this.inputs.get(inputId)
    if (!origin || origin.sessionId !== sessionId || origin.settled) return undefined
    origin.claims++
    let released = false
    return {
      clientId: origin.clientId,
      isCurrent: () => !released && this.inputs.get(inputId) === origin,
      release: () => {
        if (released) return
        released = true
        origin.claims--
        if (origin.settled && origin.claims === 0 && this.inputs.get(inputId) === origin) this.inputs.delete(inputId)
      },
    }
  }

  finishTurn(sessionId: string, queuedInputs: ReadonlySet<string>): void {
    this.settleTurn(sessionId, queuedInputs, false)
  }

  cancelTurn(sessionId: string, queuedInputs: ReadonlySet<string>): void {
    this.settleTurn(sessionId, queuedInputs, true)
  }

  private settleTurn(sessionId: string, queuedInputs: ReadonlySet<string>, cancel: boolean): void {
    for (const [inputId, origin] of this.inputs) {
      if (origin.sessionId !== sessionId || queuedInputs.has(inputId)) continue
      origin.settled = true
      if (cancel || origin.claims === 0) this.inputs.delete(inputId)
    }
  }

  retireClient(clientId: string): void {
    for (const [inputId, origin] of this.inputs) {
      if (origin.clientId === clientId) this.inputs.delete(inputId)
    }
  }

  retireSession(sessionId: string): void {
    for (const [inputId, origin] of this.inputs) {
      if (origin.sessionId === sessionId) this.inputs.delete(inputId)
    }
  }

  clear(): void {
    this.inputs.clear()
  }
}

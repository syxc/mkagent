import type { WebContents } from 'electron'
import type { BrowserInputResult } from '@mkagent/shared/agent'

type InputClassification = BrowserInputResult['browserInput']

const WORLD = 'mkagent-browser-input'
const STATE = '__mkagentBrowserInput'

// Run before site scripts, in a world whose state and DOM prototypes the page cannot replace.
const SOURCE = `(() => {
  let run
  const classify = target => {
    if (!(target instanceof Element)) return 'unknown'
    if (target instanceof HTMLInputElement) return target.type === 'password' ? 'password' : 'ordinary'
    if (target instanceof HTMLTextAreaElement || target.isContentEditable) return 'ordinary'
    return 'unknown'
  }
  const observe = target => {
    const value = classify(target)
    if (value === 'password' || run.classification === 'password') run.classification = 'password'
    else if (value === 'unknown') run.classification = 'unknown'
  }
  for (const type of ['focusin', 'keydown', 'paste', 'beforeinput', 'input']) {
    window.addEventListener(type, event => {
      if (!run || (!event.isTrusted && type !== 'input' && type !== 'focusin')) return
      observe(event.composedPath()[0])
      if (event.isTrusted && type === 'beforeinput') run.before++
      if (event.isTrusted && type === 'input') run.inputs++
    }, true)
  }
  Object.defineProperty(globalThis, '${STATE}', { value: (action, token) => {
    if (action === 'start') {
      run = { token, classification: 'ordinary', before: 0, inputs: 0 }
      return true
    }
    if (!run || run.token !== token) return null
    const result = run
    run = undefined
    return result
  } })
})()`

type InputRecord = { classification: InputClassification; before: number; inputs: number }

/** Records only target classifications; page text and input values never leave the renderer. */
export class BrowserInputTracker {
  private contexts = new Set<number>()
  private revision = 0
  private sequence = 0
  private ready?: Promise<void>
  private active = false

  constructor(
    webContents: WebContents,
    private readonly send: (method: string, params?: Record<string, unknown>) => Promise<any>,
  ) {
    webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Runtime.executionContextCreated' && params.context?.name === WORLD) {
        this.contexts.add(params.context.id)
        this.revision++
      } else if (method === 'Runtime.executionContextDestroyed' && this.contexts.delete(params.executionContextId)) {
        this.revision++
      } else if (method === 'Runtime.executionContextsCleared') {
        this.contexts.clear()
        this.revision++
      }
    })
  }

  invalidate(): void {
    this.contexts.clear()
    this.revision++
    this.ready = undefined
  }

  prepare(): Promise<void> {
    return this.ready ??= (async () => {
      await this.send('Page.enable')
      await this.send('Runtime.enable')
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE, worldName: WORLD })
    })().catch(error => { this.ready = undefined; throw error })
  }

  async record<T>(expectedInputs: number, action: () => Promise<T>): Promise<{ value: T; browserInput: InputClassification }> {
    // Concurrent actions cannot reliably associate renderer events with one command.
    if (this.active) {
      this.revision++
      return { value: await action(), browserInput: 'unknown' }
    }
    this.active = true
    const token = ++this.sequence
    const contexts = [...this.contexts]
    const revision = this.revision
    const evaluate = async (contextId: number, command: string): Promise<any> => {
      const result = await this.send('Runtime.evaluate', {
        contextId, expression: `globalThis.${STATE}?.('${command}', ${token})`, returnByValue: true,
      })
      if (result.exceptionDetails) throw new Error('Browser input recorder unavailable')
      return result.result?.value
    }
    let armed = false
    try {
      armed = contexts.length > 0 && (await Promise.all(contexts.map(id => evaluate(id, 'start').catch(() => false)))).every(Boolean)
      const value = await action()
      const records = await Promise.all(contexts.map(id => evaluate(id, 'finish').catch(() => null))) as Array<InputRecord | null>
      const password = records.some(record => record?.classification === 'password')
      const observed = records.reduce((total, record) => total + (record?.inputs ?? 0), 0)
      const complete = armed && revision === this.revision && observed === expectedInputs && records.every(record => record
        && record.classification === 'ordinary' && record.before === record.inputs)
      return { value, browserInput: password ? 'password' : complete ? 'ordinary' : 'unknown' }
    } finally {
      if (armed) await Promise.all(contexts.map(id => evaluate(id, 'finish').catch(() => null)))
      this.active = false
    }
  }
}

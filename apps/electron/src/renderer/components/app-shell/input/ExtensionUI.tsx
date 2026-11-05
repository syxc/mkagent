import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle, Square } from 'lucide-react'
import type { ExtensionUIDialog, ExtensionUIResponse, ExtensionUISnapshot } from '@mkagent/shared/protocol'
import { usePlatform } from '@mkagent/ui'
import { Button } from '@/components/ui/button'
import {
  DECISION_ACTION, DecisionActions, DecisionBody, DecisionCard, DecisionDetails,
  DecisionHeader, DecisionSpacer,
} from './structured/DecisionCard'

export function ExtensionUIWidgets({ snapshot, placement }: {
  snapshot?: ExtensionUISnapshot
  placement: 'aboveEditor' | 'belowEditor'
}) {
  const { onOpenUrl } = usePlatform()
  const widgets = snapshot?.widgets.filter(widget => (widget.placement ?? 'aboveEditor') === placement) ?? []
  if (widgets.length === 0) return null
  return (
    <div className="my-2 space-y-1 text-label text-secondary">
      {widgets.map(widget => (
        <pre key={widget.key} aria-label={widget.key} className="whitespace-pre-wrap break-words font-mono text-mono-ui">
          {widget.lines.map((line, index) => (
            <React.Fragment key={index}>
              {index > 0 && '\n'}
              {/^https?:\/\/\S+$/u.test(line) && URL.canParse(line) ? (
                <a href={line} target="_blank" rel="noopener noreferrer" className="underline"
                  onClick={event => { if (onOpenUrl) { event.preventDefault(); onOpenUrl(line) } }}>
                  {line}
                </a>
              ) : line}
            </React.Fragment>
          ))}
        </pre>
      ))}
    </div>
  )
}

export function ExtensionUIStatus({ snapshot }: { snapshot?: ExtensionUISnapshot }) {
  if (!snapshot?.statuses.length) return null
  return (
    <div role="status" className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-label-sm text-secondary">
      {snapshot.statuses.map(status => <span key={status.key} aria-label={status.key}>{status.text}</span>)}
    </div>
  )
}

/** Keep the form mounted while a host approval takes priority, preserving unsent input. */
export function ExtensionUIDialogCard({ request, blocked, focused, respond, onStop }: {
  request: ExtensionUIDialog
  blocked: boolean
  focused: boolean
  respond: (response: ExtensionUIResponse) => Promise<boolean>
  onStop?: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = React.useState(request.method === 'editor' ? request.prefill ?? '' : '')
  const [selection, setSelection] = React.useState('-1')
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null)
  const cancelRef = React.useRef<HTMLButtonElement | null>(null)
  const inFlight = React.useRef(false)
  const composing = React.useRef(false)
  React.useEffect(() => {
    if (!blocked && focused) (inputRef.current ?? cancelRef.current)?.focus({ preventScroll: true })
  }, [blocked, focused])

  const send = async (response: ExtensionUIResponse) => {
    if (blocked || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await respond(response)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const value = request.method === 'select' ? request.options[Number(selection)] : text
  const submit = () => {
    if (request.method === 'confirm') {
      void send({ type: 'extension_ui_response', id: request.id, confirmed: true })
    } else if (value !== undefined) {
      void send({ type: 'extension_ui_response', id: request.id, value })
    }
  }
  const cancel = () => { void send({ type: 'extension_ui_response', id: request.id, cancelled: true }) }
  const fieldClass = 'mt-2 w-full rounded-md border border-separator bg-sunken px-3 py-2 text-label outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <div hidden={blocked} className="mb-2">
      <DecisionCard tone="info" standalone>
        <form
          role="dialog"
          aria-modal={false}
          aria-label={request.title}
          onSubmit={event => { event.preventDefault(); if (!composing.current) submit() }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              event.stopPropagation()
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              cancel()
            }
          }}
        >
          <fieldset disabled={busy || blocked} className="min-w-0">
            <DecisionBody>
              <DecisionHeader tone="info" icon={<Puzzle />} title={request.title} />
              <DecisionDetails>
                {request.method === 'confirm' && <p className="whitespace-pre-wrap text-label text-secondary">{request.message}</p>}
                {request.method === 'select' && (
                  <select
                    ref={element => { inputRef.current = element }}
                    aria-label={request.title}
                    className={fieldClass}
                    value={selection}
                    onChange={event => setSelection(event.target.value)}
                  >
                    <option value="-1" disabled>{request.title}</option>
                    {request.options.map((option, index) => <option key={index} value={String(index)}>{option}</option>)}
                  </select>
                )}
                {request.method === 'input' && (
                  <input
                    type={request.sensitive ? 'password' : 'text'}
                    autoComplete={request.sensitive ? 'off' : undefined}
                    autoCapitalize={request.sensitive ? 'none' : undefined}
                    spellCheck={request.sensitive ? false : undefined}
                    ref={element => { inputRef.current = element }}
                    aria-label={request.title}
                    className={fieldClass}
                    placeholder={request.placeholder}
                    value={text}
                    onChange={event => setText(event.target.value)}
                  />
                )}
                {request.method === 'editor' && (
                  <textarea
                    ref={element => { inputRef.current = element }}
                    aria-label={request.title}
                    className={`${fieldClass} min-h-24 max-h-64 resize-y font-mono`}
                    value={text}
                    onChange={event => setText(event.target.value)}
                  />
                )}
              </DecisionDetails>
            </DecisionBody>
            <DecisionActions>
              <Button type="submit" variant="primary" size="lg" className={DECISION_ACTION} disabled={value === undefined}>
                {t('common.continue')}
              </Button>
              <Button ref={cancelRef} type="button" variant="ghost" size="lg" className={DECISION_ACTION} onClick={cancel}>
                {t('common.cancel')}
              </Button>
              <DecisionSpacer />
              {onStop && (
                <Button type="button" variant="ghost" size="lg" className={DECISION_ACTION} onClick={onStop} aria-label={t('chat.stopResponse')}>
                  <Square className="size-3.5" />
                  {t('chat.stopResponse')}
                </Button>
              )}
            </DecisionActions>
          </fieldset>
        </form>
      </DecisionCard>
    </div>
  )
}

import { describe, expect, it } from 'bun:test'
import { actions } from '../definitions'
import { evaluateWhen, type KeybindingContext } from '../keybinding-context'
import type { ActionDefinition } from '../types'

describe('permission mode shortcut', () => {
  const context: KeybindingContext = {
    inputFocus: false,
    hasSelection: false,
    chatFocus: true,
    navigatorFocus: false,
    sidebarFocus: false,
    menuOpen: false,
  }

  it('allows Shift+Tab during normal composition', () => {
    const action: ActionDefinition = actions['chat.cyclePermissionMode']
    expect(evaluateWhen(action.when, context)).toBe(true)
  })

  it('preserves Shift+Tab for an open dialog', () => {
    const action: ActionDefinition = actions['chat.cyclePermissionMode']
    expect(evaluateWhen(action.when, { ...context, menuOpen: true })).toBe(false)
  })
})

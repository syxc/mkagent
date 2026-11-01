import { describe, expect, it } from 'bun:test';
import { executeBrowserToolCommand } from '../browser-tool-runtime.ts';
import { browserInputClassifications, redactBrowserInputEvidence } from '../browser-input-evidence.ts';
import type { BrowserPaneFns } from '../browser-tools.ts';

function page() {
  let focused = '@ordinary';
  return {
    fill: async (ref: string) => { focused = ref; },
    type: async () => {}, setClipboard: async () => {}, sendKey: async () => {},
    click: async (ref: string) => { if (ref === '@fail') throw new Error('fixture failure'); focused = ref; },
    detectChallenge: async () => ({ detected: false, provider: 'none', signals: [] }),
    evaluate: async () => ({ url: 'https://example.test', title: 'Fixture', activeElementTag: 'input',
      ...(focused === '@unknown' ? {} : { activeElementIsPassword: focused === '@password' }) }),
  } as unknown as BrowserPaneFns;
}

describe('browser input evidence', () => {
  it('does not treat the final focus as proof of the input target', async () => {
    for (const command of ['fill @password fixture-input', 'type fixture-input', 'paste fixture-input']) {
      const fns = page();
      fns.evaluate = async () => ({ activeElementTag: 'input', activeElementIsPassword: false });
      const result = await executeBrowserToolCommand({ command, fns, sessionId: 'focus-change-fixture' });
      expect(result.browserInput).toEqual(['unknown']);
    }
  });

  it('uses execution evidence even when the final focus differs', async () => {
    for (const classification of ['ordinary', 'password'] as const) {
      const fns = page();
      fns.fill = async () => ({ browserInput: classification });
      fns.type = async () => ({ browserInput: classification });
      fns.sendKey = async () => ({ browserInput: classification });
      fns.evaluate = async () => ({ activeElementTag: 'input', activeElementIsPassword: false });
      for (const command of ['fill @ordinary fixture-input', 'type fixture-input', 'paste fixture-input']) {
        const result = await executeBrowserToolCommand({ command, fns, sessionId: 'execution-evidence' });
        expect(result.browserInput).toEqual([classification]);
        if (classification === 'password') expect(result.output).not.toContain('fixture-input');
      }
    }
  });

  it('keeps classifications at original command positions and marks stopped commands unknown', async () => {
    const result = await executeBrowserToolCommand({
      command: 'fill @ordinary ordinary; type ordinary; paste ordinary; fill @password secret; type secret; paste secret; click @ordinary; type unexecuted',
      fns: page(), sessionId: 'evidence-test',
    });
    expect(result.browserInput).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'none', 'unknown']);
    expect(JSON.stringify(result.browserInput)).not.toContain('secret');
  });

  it('requires positive boolean metrics and leaves failed batches without success evidence', async () => {
    const fns = page();
    for (const command of ['fill @unknown input', 'type input', 'paste input']) {
      const result = await executeBrowserToolCommand({ command, fns, sessionId: 'evidence-test' });
      expect(result.browserInput).toEqual(['unknown']);
    }
    await expect(executeBrowserToolCommand({ command: 'fill @password secret; click @fail', fns, sessionId: 'evidence-test' })).rejects.toThrow('fixture failure');
  });

  it('redacts only classified command spans with repeated text and array values', () => {
    const secrets: unknown[] = [];
    const command = ' type same ; type same; fill @password "secret\\nline"; paste ordinary ';
    const classifications = ['ordinary', 'password', 'password', 'ordinary'] as const;
    expect(redactBrowserInputEvidence(command, [...classifications], value => secrets.push(value)))
      .toBe(' type same ; type ; fill @password ; paste ordinary ');
    expect(redactBrowserInputEvidence(['paste', 'secret value'], ['password'], value => secrets.push(value))).toEqual(['paste', '']);
    expect(secrets).toEqual(['same', '"secret\\nline"', ['secret value']]);
    expect(browserInputClassifications(['none'], 'type input')).toBeUndefined();
    expect(browserInputClassifications(['ordinary'], 'click @ordinary')).toBeUndefined();
    expect(browserInputClassifications(['ordinary'], 'type input; paste input')).toBeUndefined();
  });
});

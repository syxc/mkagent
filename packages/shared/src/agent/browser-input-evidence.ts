import { redactBrowserToolInput } from './browser-tool-redaction.ts';
import { splitBatchCommands, tokenizeCommand } from './browser-tool-runtime.ts';

export const BROWSER_INPUT_EVIDENCE = 'mkagent.browser-input-evidence';
export type BrowserInputClassification = 'none' | 'ordinary' | 'password' | 'unknown';

/** Evidence contains only classifications; command positions provide the association. */
export function browserInputClassifications(value: unknown, command: unknown): BrowserInputClassification[] | undefined {
  const parts = typeof command === 'string' ? splitBatchCommands(command.trim()).map(tokenizeCommand)
    : Array.isArray(command) && command.every(item => typeof item === 'string') ? [command] : [];
  if (!parts.length || !Array.isArray(value) || value.length !== parts.length) return undefined;
  return value.every((classification, index) => ['fill', 'type', 'paste'].includes(parts[index]![0]?.toLowerCase() ?? '')
    ? ['ordinary', 'password', 'unknown'].includes(classification)
    : classification === 'none' || classification === 'unknown') ? value as BrowserInputClassification[] : undefined;
}

export function redactBrowserInputEvidence(
  command: string | string[], classifications: BrowserInputClassification[], onRedact: (value: string | readonly unknown[]) => void,
): string | string[] {
  const parts = typeof command === 'string' ? splitBatchCommands(command.trim()) : [command];
  let copied = 0;
  let searchFrom = 0;
  let output = '';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const tokens = typeof part === 'string' ? tokenizeCommand(part) : part;
    const start = typeof command === 'string' ? command.indexOf(part as string, searchFrom) : 0;
    searchFrom = start + part.length;
    if (classifications[index] !== 'password') continue;
    const redacted = redactBrowserToolInput({ command: part }, tokens[0]?.toLowerCase() === 'fill' ? [tokens[1]!] : [], {
      typedText: true, redactPlaceholders: true, placeholder: '', onRedact,
    }).command as string | string[];
    if (Array.isArray(command)) return redacted;
    output += command.slice(copied, start) + redacted;
    copied = start + (part as string).length;
  }
  return typeof command === 'string' && copied ? output + command.slice(copied) : command;
}

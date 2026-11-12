/** Exclude upstream transport entry points while preserving plugin components. */
export function excludeRunModeEntries(path: string, body: string): string | undefined {
  if (path !== 'index.ts') return undefined;
  const removed = [
    '\tInteractiveMode,\n', '\ttype InteractiveModeOptions,\n', '\ttype PrintModeOptions,\n',
    '\trunPrintMode,\n', '\trunRpcMode,\n',
  ];
  const comment = ['// Run modes for programmatic SDK usage', '// RPC client and protocol for programmatic SDK usage'];
  for (const before of [...removed, comment[0]]) {
    if (body.split(before).length !== 2) throw new Error(`Pinned run mode export changed: ${path}`);
    body = body.replace(before, before === comment[0] ? comment[1] : '');
  }
  return body;
}

/** Let hosts bind image assets without replacing the SDK renderer lifecycle. */
export function codingUIPolicy(source: string, declarations: boolean): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published UI boundary changed: ' + before);
    source = source.replace(before, after);
  };
  const marker = '    /**\n     * Show new partial arguments.';
  edit(marker, (declarations
    ? '    protected _ensurePngTranscoder(onRegistered: () => void): void;\n'
    : '    _ensurePngTranscoder(onRegistered) {\n        ensurePngTranscoder(onRegistered);\n    }\n') + marker);
  if (!declarations) edit('ensurePngTranscoder(() => {', 'this._ensurePngTranscoder(() => {');
  return source;
}

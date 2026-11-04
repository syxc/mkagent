/** Keep the host threshold separate from persisted native settings and model overrides. */
export function portSettingsManager(source: string): string {
  let body = 'import { compactionReserveFor } from "../../compaction-reserve.ts";\n' + source;
  const replace = (before: string, after: string) => {
    if (!body.includes(before)) throw new Error('Pinned native compaction settings changed: ' + before);
    body = body.replace(before, after);
  };
  replace('export class SettingsManager {', `export class SettingsManager {
\tprivate hostAutoCompactWindow: number | undefined;

\t/** Memory-only host policy survives native save/reload and is resolved for each model. */
\tsetHostAutoCompactWindow(window: number | undefined): void {
\t\tthis.hostAutoCompactWindow = window;
\t}
`);
  replace('getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {\n\t\treturn this.getCompactionTokenSetting("reserveTokens", model);',
    `getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id"> & { contextWindow?: number }): number {
\t\treturn compactionReserveFor(model?.contextWindow,
\t\t\tthis.getCompactionTokenSetting("reserveTokens", model), this.hostAutoCompactWindow);`);
  replace('getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">):',
    'getCompactionSettings(model?: Pick<Model<string>, "provider" | "id"> & { contextWindow?: number }):');
  return body;
}

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Export HTML must work offline, including bundles without node_modules. */
export function readMarkedSource(templateDir?: string): string {
  let path = templateDir && join(templateDir, 'vendor', 'marked.min.js');
  if (!path || !existsSync(path)) {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('marked/package.json');
    const { browser } = JSON.parse(readFileSync(packagePath, 'utf8')) as { browser: string };
    path = join(dirname(packagePath), browser);
  }
  return readFileSync(path, 'utf8').replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm, '');
}

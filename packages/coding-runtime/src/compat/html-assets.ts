import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Export HTML must work offline, including bundles without node_modules. */
export function readHtmlVendorSource(name: 'marked.min.js' | 'highlight.min.js', templateDir?: string): string {
  let path = templateDir && join(templateDir, 'vendor', name);
  let license = '';
  if (!path || !existsSync(path)) {
    const require = createRequire(import.meta.url);
    if (name === 'marked.min.js') {
      const packagePath = require.resolve('marked/package.json');
      const { browser } = JSON.parse(readFileSync(packagePath, 'utf8')) as { browser: string };
      path = join(dirname(packagePath), browser);
    } else {
      path = require.resolve('@highlightjs/cdn-assets/highlight.min.js');
      // Standalone HTML exports must carry the BSD notice.
      license = `/*\n${readFileSync(require.resolve('@highlightjs/cdn-assets/LICENSE'), 'utf8')}*/\n`;
    }
  }
  return license + readFileSync(path, 'utf8').replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm, '');
}

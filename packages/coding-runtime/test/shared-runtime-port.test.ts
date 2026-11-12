import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { excludeRunModeEntries } from '../scripts/shared-helper-port.ts';

test('run mode exclusion preserves plugin components and RPC at the root entry', () => {
  const fixtures = [
    {
      path: 'index.ts',
      removed: ['\tInteractiveMode,\n', '\ttype InteractiveModeOptions,\n', '\ttype PrintModeOptions,\n', '\trunPrintMode,\n', '\trunRpcMode,\n'],
      source: '// Run modes for programmatic SDK usage\nexport {\n\tInteractiveMode,\n\ttype InteractiveModeOptions,\n\ttype PrintModeOptions,\n\trunPrintMode,\n\trunRpcMode,\n\tRpcClient,\n} from "./modes/index.ts";\nexport { CustomEditor, Theme } from "./components.ts";\n',
      targets: ['./modes/index.ts', './components.ts'],
    },
  ];
  for (const { path, source, removed, targets } of fixtures) {
    const body = excludeRunModeEntries(path, source)!;
    const parsed = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
    const exports = parsed.statements.filter(ts.isExportDeclaration);
    assert.deepEqual(exports.map(node => (node.moduleSpecifier as ts.StringLiteral).text), targets);
    assert(body.includes('RpcClient'));
    if (path === 'index.ts') assert(body.includes('CustomEditor, Theme'));
    for (const declaration of removed) {
      assert(!body.includes(declaration));
      assert.throws(() => excludeRunModeEntries(path, source.replace(declaration, '')), /run mode export changed/);
      assert.throws(() => excludeRunModeEntries(path, source + declaration), /run mode export changed/);
    }
  }
  assert.equal(excludeRunModeEntries('modes/index.ts', 'retired barrel'), undefined);
  assert.equal(excludeRunModeEntries('modes/rpc/rpc-types.ts', 'protocol'), undefined);
});

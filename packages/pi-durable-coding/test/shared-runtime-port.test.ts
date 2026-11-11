import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { applySharedHelperPort, excludeRunModeEntries } from '../scripts/shared-helper-port.ts';

const declarationFixtures = [
  {
    name: 'string enum',
    port: (body: string) => applySharedHelperPort('core/extensions/pi-ai-extension-view.ts', body)!.body,
    source: `import { type TUnsafe, Type } from "typebox";
export function StringEnum<T extends readonly string[]>(
\tvalues: T,
\toptions?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
\treturn Type.Unsafe<T[number]>({
\t\ttype: "string",
\t\tenum: values as unknown as T[number][],
\t\t...(options?.description && { description: options.description }),
\t\t...(options?.default && { default: options.default }),
\t});
}
`,
  },
];

for (const { name, source, port } of declarationFixtures) {
  const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration);
  for (const fn of functions) {
    const start = fn.getStart(parsed);
    const bodyStart = fn.body!.getStart(parsed);
    const header = source.slice(start, bodyStart);
    test(`${name}: discarded ${fn.name!.text} body cannot change the generated module`, () => {
      const baseline = port(source);
      const changed = source.slice(0, bodyStart) + '{ throw new Error("changed upstream algorithm"); }' + source.slice(fn.end);
      assert.notEqual(changed, source);
      assert.equal(port(changed), baseline);
    });
    test(`${name}: ${fn.name!.text} parameter and return types remain guarded`, () => {
      for (const changedHeader of [header.replace(/: [^,)]+/, ': never'), header.replace(/\): [^{]+$/, '): never ')]) {
        assert.notEqual(changedHeader, header);
        assert.throws(() => port(source.slice(0, start) + changedHeader + source.slice(bodyStart)));
      }
    });
    test(`${name}: ${fn.name!.text} duplicates remain rejected`, () => {
      assert.throws(() => port(source + '\n' + fn.getText(parsed)));
    });
  }
  test(`${name}: missing declarations remain rejected`, () => {
    assert.throws(() => port(''));
  });
}

for (const { name, source, port } of declarationFixtures) {
  const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(ts.isFunctionDeclaration)!;
  const header = source.slice(fn.getStart(parsed), fn.body!.getStart(parsed));
  test(`${name}: function kind, export and calling convention remain guarded`, () => {
    const changedDeclarations = [
      `export const ${fn.name!.text} = () => 0;`,
      `export class ${fn.name!.text} {}`,
      `export type ${fn.name!.text} = number;`,
      `export interface ${fn.name!.text} {}`,
      header + ';',
      fn.getText(parsed).replace('export function', 'function'),
      fn.getText(parsed).replace('export function', 'export async function'),
      fn.getText(parsed).replace('export function', 'export function*'),
    ];
    for (const changed of changedDeclarations) {
      assert.throws(() => port(source.slice(0, fn.getStart(parsed)) + changed + source.slice(fn.end)));
    }
  });
}

test('string enum: generic bounds, optional options and TypeBox branding remain guarded', () => {
  const { source, port } = declarationFixtures[0];
  for (const [from, to] of [
    ['T extends readonly string[]', 'T extends readonly number[]'],
    ['options?:', 'options:'],
    ['default?: T[number]', 'default?: string'],
    ['TUnsafe<T[number]>', 'T[number]'],
  ]) {
    const changed = source.replace(from, to);
    assert.notEqual(changed, source);
    assert.throws(() => port(changed));
  }
});

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

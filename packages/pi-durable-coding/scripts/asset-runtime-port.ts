import ts from 'typescript';

/** Resolve executable image workers only from the installed coding runtime. */
export function portImageAssets(path: string, source: string): string {
  const edit = (before: string, after: string) => {
    if (!source.includes(before)) throw new Error('Pinned image asset boundary changed: ' + path);
    source = source.replace(before, after);
  };
  if (path === 'utils/image-resize.ts') edit(
    `\t// Bun compiled executables resolve worker entrypoints by string path, not via
\t// new URL(..., import.meta.url). Try the string path first under Bun so the
\t// release binary uses the embedded worker instead of falling back in-process.
\tif (typeof process.versions.bun === "string") {
\t\ttry {
\t\t\treturn await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
\t\t} catch {}
\t}
`,
    '\t// A project directory cannot supply executable image workers. Use the module URL or process locally.\n',
  );
  return source;
}

/** Keep public declarations independent of the discarded CJS loader implementation. */
export function portPhotonRuntime(source: string): string {
  const parsed = ts.createSourceFile('photon.ts', source, ts.ScriptTarget.Latest, true);
  const exports = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node)
    || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)));
  const load = exports.find(ts.isFunctionDeclaration);
  const image = exports.find(ts.isExportDeclaration);
  const modules = new Set(['@silvia-odwyer/photon-node', '@silvia-odwyer/photon/photon_rs.js']);
  const result = load?.type;
  const union = result && ts.isTypeReferenceNode(result) && result.typeName.getText(parsed) === 'Promise'
    && result.typeArguments?.length === 1 ? result.typeArguments[0] : undefined;
  const members: readonly ts.TypeNode[] = union && ts.isUnionTypeNode(union) ? union.types : [];
  const namespace = members.find(ts.isImportTypeNode);
  const specifiers = image?.exportClause && ts.isNamedExports(image.exportClause) ? image.exportClause.elements : [];
  if (exports.length !== 2 || !load || load.name?.text !== 'loadPhoton' || load.parameters.length
    || load.typeParameters?.length || load.asteriskToken
    || !load.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || load.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    || members.length !== 2 || !members.some(node => ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword)
    || !namespace?.isTypeOf || namespace.qualifier || namespace.typeArguments?.length
    || !ts.isLiteralTypeNode(namespace.argument) || !ts.isStringLiteral(namespace.argument.literal)
    || !modules.has(namespace.argument.literal.text)
    || !image || !image.moduleSpecifier || !ts.isStringLiteral(image.moduleSpecifier)
    || !modules.has(image.moduleSpecifier.text) || specifiers.length !== 1
    || !(image.isTypeOnly || specifiers[0]!.isTypeOnly)
    || specifiers[0]!.name.text !== 'PhotonImageType' || specifiers[0]!.propertyName?.text !== 'PhotonImage') {
    throw new Error('Native Photon public boundary changed');
  }
  return '/** Use the same public Photon runtime and WASM asset as durable. */\n'
    + 'export { loadPhoton, type PhotonImageType } from "../../compat/photon.ts";\n';
}

/** Use published browser assets without copying their upstream implementation. */
export function portHtmlVendorAssets(source: string): string {
  for (const [variable, name] of [['markedJs', 'marked.min.js'], ['hljsJs', 'highlight.min.js']]) {
    const before = `const ${variable} = readFileSync(join(templateDir, "vendor", "${name}"), "utf-8");`;
    if (source.split(before).length !== 2) throw new Error(`Native HTML ${name} asset boundary changed`);
    source = source.replace(before, `const ${variable} = readHtmlVendorSource("${name}", templateDir);`);
  }
  return 'import { readHtmlVendorSource } from "../../../compat/html-assets.ts";\n' + source;
}

/** Bundles carry the same non-code assets as the source package. */
export function portBundledAssets(source: string): string {
  for (const [name, directory] of [
    ['getThemesDir', 'theme'], ['getExportTemplateDir', 'export-html'], ['getInteractiveAssetsDir', 'assets'],
  ]) {
    const signature = `export function ${name}(): string {`;
    if (!source.includes(signature)) throw new Error('Pinned asset resolver changed: ' + name);
    source = source.replace(signature, `${signature}
\tconst bundled = join(isBunBinary ? dirname(process.execPath) : __dirname, "coding-assets", "${directory}");
\tif (existsSync(bundled)) return bundled;`);
  }
  return source;
}

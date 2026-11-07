/** Preserve Native forwarding boundaries while reusing public implementations. */
import { createHash } from 'node:crypto';
import ts from 'typescript';

export function portCodemodeRuntime(body: string): string {
  const parsed = ts.createSourceFile('execute.ts', body, ts.ScriptTarget.Latest, true);
  const functions = new Map(parsed.statements.filter(ts.isFunctionDeclaration)
    .flatMap(node => node.name ? [[node.name.text, node] as const] : []));
  const execute = functions.get('executeCodemode'), store = functions.get('readCodemodeStore');
  if (!execute || execute.parameters.length !== 6 ||
      execute.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== 'toolCallId,input,signal,onUpdate,ctx,options' ||
      execute.type?.getText(parsed) !== 'Promise<AgentToolResult<CodemodeToolDetails>>' ||
      !store || store.parameters.length !== 1 || store.parameters[0].name.getText(parsed) !== 'branch' ||
      store.type?.getText(parsed) !== 'Record<string, unknown>') {
    throw new Error('Native codemode public boundary changed');
  }
  return '/** Native policy over the public durable codemode executor. */\n'
    + 'export { executeNativeCodemode as executeCodemode, readCodemodeStore } from "../../../compat/codemode-native.ts";\n';
}

export function portImageOrientation(body: string): string {
  const parsed = ts.createSourceFile('exif-orientation.ts', body, ts.ScriptTarget.Latest, true);
  const exports = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const apply = exports[0];
  if (exports.length !== 1 || !apply || !ts.isFunctionDeclaration(apply) || apply.name?.text !== 'applyExifOrientation' ||
      apply.modifiers?.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword) ||
      apply.parameters.some(parameter => parameter.questionToken || parameter.initializer || parameter.dotDotDotToken) ||
      apply.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== 'photon,image,originalBytes' ||
      apply.parameters.map(parameter => parameter.type?.getText(parsed)).join(',') !== 'Photon,PhotonImageType,Uint8Array' ||
      apply.type?.getText(parsed) !== 'PhotonImageType') {
    throw new Error('Native EXIF orientation boundary changed');
  }
  return '/** Native Photon ownership over durable\'s shared EXIF algorithms. */\n'
    + 'export { applyExifOrientation } from "../../compat/image-orientation.ts";\n';
}

export function portImageResize(body: string): string {
  const parsed = ts.createSourceFile('image-resize-core.ts', body, ts.ScriptTarget.Latest, true);
  const exported = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const names = exported.map(node => ts.isVariableStatement(node)
    ? node.declarationList.declarations[0].name.getText(parsed)
    : ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)
      ? node.name?.text ?? '' : '');
  const expected = ['ImageResizeOptions', 'ResizedImage', 'IMAGE_RESIZE_WORKER_RESPONSE_TYPE',
    'ResizeImageWorkerResponse', 'resizeImageInProcess'];
  const apply = exported.find(node => ts.isFunctionDeclaration(node));
  const shapes: Record<string, string> = {
    ImageResizeOptions: 'maxWidth?:number;maxHeight?:number;maxBytes?:number;jpegQuality?:number;',
    ResizedImage: 'data:string;mimeType:string;originalWidth:number;originalHeight:number;width:number;height:number;wasResized:boolean;',
  };
  const compact = (text: string) => text.replace(/\/\/[^\n]*/g, '').replace(/\s/g, '');
  const response = exported.find(ts.isTypeAliasDeclaration);
  const tagDeclaration = exported.find(ts.isVariableStatement);
  const tag = tagDeclaration?.declarationList.declarations[0].initializer;
  if (names.join(',') !== expected.join(',') ||
      exported.some(node => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier =>
        modifier.kind !== ts.SyntaxKind.ExportKeyword &&
        !(ts.isFunctionDeclaration(node) && modifier.kind === ts.SyntaxKind.AsyncKeyword))) ||
      exported.filter(ts.isInterfaceDeclaration).some(node => compact(node.members.map(member => member.getText(parsed)).join('')) !== shapes[node.name.text]) ||
      !tagDeclaration || tagDeclaration.declarationList.declarations.length !== 1 ||
      !(tagDeclaration.declarationList.flags & ts.NodeFlags.Const) ||
      tagDeclaration.declarationList.declarations[0].type !== undefined ||
      !tag || !ts.isStringLiteral(tag) || tag.text !== 'pi:image-resize-response' ||
      !response || compact(response.type.getText(parsed)) !==
        '|{type:typeofIMAGE_RESIZE_WORKER_RESPONSE_TYPE;result:ResizedImage|null}|{type:typeofIMAGE_RESIZE_WORKER_RESPONSE_TYPE;error:string}' ||
      !apply || !ts.isFunctionDeclaration(apply) ||
      !apply.body || apply.typeParameters?.length ||
      !apply.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      apply.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== 'inputBytes,mimeType,options' ||
      apply.parameters.map(parameter => parameter.type?.getText(parsed)).join(',') !== 'Uint8Array,string,ImageResizeOptions' ||
      apply.parameters.some((parameter, index) => !!parameter.questionToken !== (index === 2) || parameter.initializer || parameter.dotDotDotToken) ||
      compact(apply.type?.getText(parsed) ?? '') !== 'Promise<ResizedImage|null>') {
    throw new Error('Native image resize boundary changed');
  }
  return '/** Native image policy over the shared durable encoding loop. */\n'
    + 'export { IMAGE_RESIZE_WORKER_RESPONSE_TYPE, resizeImageInProcess } from "../../compat/image-resize.ts";\n'
    + 'export type { ImageResizeOptions, ResizedImage, ResizeImageWorkerResponse } from "../../compat/image-resize.ts";\n';
}

export function portImageMime(body: string): string {
  const parsed = ts.createSourceFile('mime.ts', body, ts.ScriptTarget.Latest, true);
  const exported = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const expected = [
    ['detectSupportedImageMimeType', 'buffer', 'Uint8Array', 'string|null'],
    ['detectSupportedImageMimeTypeFromFile', 'filePath', 'string', 'Promise<string|null>'],
  ];
  const limit = parsed.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations])
    .find(node => node.name.getText(parsed) === 'IMAGE_TYPE_SNIFF_BYTES')?.initializer;
  if (exported.length !== expected.length || !limit || !ts.isNumericLiteral(limit) || limit.text !== '4100' ||
      exported.some((node, index) => !ts.isFunctionDeclaration(node) || !node.body || node.typeParameters?.length ||
        node.asteriskToken || node.name?.text !== expected[index][0] ||
        node.modifiers?.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.AsyncKeyword) ||
        !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== (index === 1) ||
        node.parameters.length !== 1 || node.parameters[0].name.getText(parsed) !== expected[index][1] ||
        node.parameters[0].type?.getText(parsed) !== expected[index][2] ||
        node.parameters[0].questionToken || node.parameters[0].initializer || node.parameters[0].dotDotDotToken ||
        node.type?.getText(parsed).replace(/\s/g, '') !== expected[index][3])) {
    throw new Error('Native image MIME boundary changed');
  }
  return '/** Native null and file-prefix policy over durable image sniffing. */\n'
    + 'export { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "../../compat/image-mime.ts";\n';
}

export function portAnsi(body: string): string {
  const parsed = ts.createSourceFile('ansi.ts', body, ts.ScriptTarget.Latest, true);
  const variables = new Map(parsed.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations].map(node => [node.name.getText(parsed), { node, statement }] as const)));
  const expected: Record<string, string> = {
    ST: String.raw`(?:\u0007|\u001B\u005C|\u009C)`,
    OSC_START: String.raw`\u001B\]`,
    CSI_START: String.raw`(?:(?:\u001B\[|\u009B)[<=>]|[\u001B\u009B][[\]()#;?]*)(?:\d{1,4}(?:[;:]\d{0,4})*)?`,
    CSI_FINAL: String.raw`[\dA-PR-TZcf-nq-uy=><~]`,
  };
  const regex = variables.get('ansiRegex')?.node.initializer;
  const pattern = regex && ts.isNewExpression(regex) ? regex.arguments?.[0] : undefined;
  const flags = regex && ts.isNewExpression(regex) ? regex.arguments?.[1] : undefined;
  if (Object.entries(expected).some(([name, text]) => {
    const value = variables.get(name)?.node.initializer;
    return !value || !ts.isStringLiteral(value) || value.text !== text;
  }) || !regex || !ts.isNewExpression(regex) || regex.expression.getText(parsed) !== 'RegExp' ||
      regex.arguments?.length !== 2 || !flags || !ts.isStringLiteral(flags) || flags.text !== 'g' ||
      !pattern || !ts.isTemplateExpression(pattern) || pattern.head.text !== '(?:' ||
      JSON.stringify(pattern.templateSpans.map(span => [span.expression.getText(parsed), span.literal.text])) !==
        JSON.stringify([['OSC_START', String.raw`[\s\S]*?`], ['ST', ')|'], ['CSI_START', ''], ['CSI_FINAL', '']])) {
    throw new Error('Native ANSI matcher boundary changed');
  }
  const edits: Array<{ start: number; end: number }> = [];
  for (const name of ['ST', 'CSI_FINAL', 'ansiRegex']) {
    const item = variables.get(name);
    if (!item || item.statement.declarationList.declarations.length !== 1) throw new Error('Native ANSI declarations changed');
    let start = item.statement.getFullStart();
    for (const comment of ts.getLeadingCommentRanges(body, item.statement.getFullStart()) ?? []) {
      if (comment.kind === ts.SyntaxKind.MultiLineCommentTrivia) start = comment.end;
    }
    edits.push({ start, end: item.statement.end });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + body.slice(edit.end);
  return 'import { nativeAnsiRegex as ansiRegex } from "../../compat/ansi.ts";\n\n' + body;
}

export function portChildProcess(body: string): string {
  const parsed = ts.createSourceFile('child-process.ts', body, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration)
    .filter(node => node.name?.text === 'waitForChildProcess');
  const wait = functions[0];
  const constants = parsed.statements.filter(ts.isVariableStatement)
    .filter(node => node.declarationList.declarations.some(declaration =>
      declaration.name.getText(parsed) === 'EXIT_STDIO_GRACE_MS'));
  const grace = constants[0];
  if (functions.length !== 1 || !wait?.body || wait.typeParameters?.length || wait.asteriskToken ||
      wait.modifiers?.length !== 1 || wait.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword ||
      wait.parameters.length !== 1 || wait.parameters[0].name.getText(parsed) !== 'child' ||
      wait.parameters[0].type?.getText(parsed) !== 'ChildProcess' || wait.parameters[0].questionToken ||
      wait.parameters[0].initializer || wait.parameters[0].dotDotDotToken ||
      wait.type?.getText(parsed).replace(/\s/g, '') !== 'Promise<number|null>' ||
      constants.length !== 1 || !grace || grace.declarationList.declarations.length !== 1 ||
      !(grace.declarationList.flags & ts.NodeFlags.Const) ||
      grace.declarationList.declarations[0].initializer?.getText(parsed) !== '100' ||
      createHash('sha256').update(wait.body.getText(parsed)).digest('hex') !==
        '1a86cc19213086210a54683cb69cdf14e7ceea8377c077733bbae86dadcb3d3f') {
    throw new Error('Native child process wait boundary changed');
  }
  const edits = [
    { start: grace.getFullStart(), end: grace.end, text: '' },
    { start: wait.getStart(parsed), end: wait.end,
      text: 'export { waitForChildProcess } from "../../compat/child-process.ts";' },
  ];
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return body;
}

export function portShell(body: string): string {
  const parsed = ts.createSourceFile('shell.ts', body, ts.ScriptTarget.Latest, true);
  const expected: Record<string, string> = {
    isLegacyWslBashPath: 'cddb113d738571244cbeaeffc75859243b4ed759a9f3436ecac69220fc5947ff',
    getBashShellConfig: 'a4362dcc7b15aa46a643446690e27b186235839f1a3673b72f619f12f1de409b',
    killProcessTree: 'a3b09ad5cc88631155c1a252988f2cf2588fe5cca1c9512343a1b086a2316668',
  };
  const imports: Record<string, string> = {
    'import { delimiter, join, win32 } from "node:path";': 'import { delimiter, win32 } from "node:path";',
    'import { spawn, spawnSync } from "child_process";': 'import { spawnSync } from "child_process";',
  };
  const remaining = new Set([...Object.keys(expected), ...Object.keys(imports)]);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && Object.hasOwn(expected, node.name.text)) {
      if (!remaining.delete(node.name.text) ||
          createHash('sha256').update(node.getText(parsed)).digest('hex') !== expected[node.name.text]) {
        throw new Error('Native shell algorithm boundary changed');
      }
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    } else if (ts.isImportDeclaration(node) && Object.hasOwn(imports, node.getText(parsed))) {
      const text = node.getText(parsed);
      remaining.delete(text);
      edits.push({ start: node.getStart(parsed), end: node.end, text: imports[text] });
    }
  }
  if (remaining.size) throw new Error('Native shell declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { getBashShellConfig, killProcessTree } from "../../compat/shell.ts";\n'
    + 'export { killProcessTree };\n' + body;
}

export function portReadPaths(body: string): string {
  const parsed = ts.createSourceFile('path-utils.ts', body, ts.ScriptTarget.Latest, true);
  const expected: Record<string, string> = {
    tryMacOSScreenshotPath: '72ed41fe9febd972126c9adc7a9a0c6a19b46f0f0f0554e568db50d570bf1e20',
    tryNFDVariant: 'ddbdbbfe8cf568dd0f099d07884a835b492393293624c60823b53100d7b31e46',
    tryCurlyQuoteVariant: 'de9d47659aa9a74abe18f78f2aea7ca8d4f66bbfb4c83723018266e7a38d96d1',
    resolveReadPath: 'fc6188a5bb489a0260455e4bc5af061fc5c057a8ef4bd6ba7d83c99707d1f378',
    resolveReadPathAsync: 'bb342a5a1d4d2b300ae2c7261e4cf91580751f34500024349993e1ddda71ae0f',
  };
  const remaining = new Set([...Object.keys(expected), 'NARROW_NO_BREAK_SPACE']);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && Object.hasOwn(expected, node.name.text)) {
      const name = node.name.text;
      if (!remaining.delete(name) || createHash('sha256').update(node.getText(parsed)).digest('hex') !== expected[name]) {
        throw new Error('Native read path algorithm boundary changed');
      }
      const text = name === 'resolveReadPath'
        ? 'export function resolveReadPath(filePath: string, cwd: string): string {\n\treturn findReadPath(resolveToCwd(filePath, cwd), fileExists);\n}'
        : name === 'resolveReadPathAsync'
          ? 'export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {\n\treturn findReadPathAsync(resolveToCwd(filePath, cwd), pathExists);\n}'
          : '';
      edits.push({ start: text ? node.getStart(parsed) : node.getFullStart(), end: node.end, text });
    } else if (ts.isVariableStatement(node) && node.getText(parsed) === 'const NARROW_NO_BREAK_SPACE = "\\u202F";') {
      if (!remaining.delete('NARROW_NO_BREAK_SPACE')) throw new Error('Duplicate Native read path constant');
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    }
  }
  if (remaining.size) throw new Error('Native read path declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { findReadPath, findReadPathAsync } from "../../../compat/read-path.ts";\n' + body;
}

export function portTruncation(body: string): string {
  const parsed = ts.createSourceFile('truncate.ts', body, ts.ScriptTarget.Latest, true);
  const expected: Record<string, string> = {
    DEFAULT_MAX_LINES: '7b4d08a1720cf3838212fc9740116c103bc1c62f22209956d7a7719999e64374',
    DEFAULT_MAX_BYTES: '7a8d5a98971a2ef71318ab0e5e74d5950848bad1b9a4a2e9f79927c6b30f01d2',
    TruncationResult: '60fbec2ea2f68e45e297f39d014243e58322e39d64258036f3db97ea9d6bae15',
    TruncationOptions: 'f29fa289a0d02f53d9dd89bbc7e3a5ef759ffa410160cf537bcceaa52559c172',
    splitLinesForCounting: 'c16490ab83da37e63ee9134b3392d884e112b93c0d11072ba668d0e2e283deb1',
    formatSize: '732147ecdfd179ec787e25aad455118aea89f7a90590d38ad850184f659274ed',
    truncateHead: '513b473a840717d9c241e6a996d860582f574b537cb796d839334b6089787250',
  };
  const remaining = new Set(Object.keys(expected));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of parsed.statements) {
    const name = ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name.getText(parsed)
      : ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ? node.name?.text : undefined;
    if (!name || !Object.hasOwn(expected, name)) continue;
    if (!remaining.delete(name) || createHash('sha256').update(node.getText(parsed)).digest('hex') !== expected[name]) {
      throw new Error('Native truncation declaration boundary changed');
    }
    if (ts.isInterfaceDeclaration(node)) continue;
    if (ts.isVariableStatement(node)) {
      const end = body.indexOf('\n', node.end);
      edits.push({ start: node.getStart(parsed), end: end < 0 ? node.end : end + 1, text: '' });
    } else {
      const text = name === 'formatSize'
        ? 'export function formatSize(bytes: number): string {\n\treturn sharedFormatSize(bytes);\n}'
        : name === 'truncateHead'
          ? 'export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {\n\treturn sharedTruncateHead(content, options);\n}'
          : '';
      edits.push({ start: text ? node.getStart(parsed) : node.getFullStart(), end: node.end, text });
    }
  }
  if (remaining.size) throw new Error('Native truncation declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, formatSize as sharedFormatSize, splitLinesForCounting } from "@earendil-works/pi-durable/tools";\n'
    + 'import { truncateHead as sharedTruncateHead } from "../../../compat/truncate.ts";\n'
    + 'export { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES };\n' + body;
}

export function portZipRuntime(body: string): string {
  const parsed = ts.createSourceFile('zip.ts', body, ts.ScriptTarget.Latest, true);
  const exports = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const entry = parsed.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ZipEntry');
  const write = exports[0];
  if (exports.length !== 1 || !write || !ts.isFunctionDeclaration(write) || write.name?.text !== 'writeZipArchive' ||
      write.modifiers?.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword) ||
      write.parameters.some(parameter => parameter.questionToken || parameter.initializer || parameter.dotDotDotToken) ||
      write.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== 'filePath,entries' ||
      write.parameters.map(parameter => parameter.type?.getText(parsed)).join(',') !== 'string,readonly ZipEntry[]' ||
      write.type?.getText(parsed) !== 'Promise<void>' || !entry || !ts.isInterfaceDeclaration(entry) ||
      entry.members.map(member => member.getText(parsed)).join('') !== 'name: string;data: string | Uint8Array;') {
    throw new Error('Native ZIP writer boundary changed');
  }
  return '/** Native archive policy over the public ZIP implementation. */\n'
    + 'export { writeZipArchive } from "../../compat/archive.ts";\n';
}

export function portToolArchives(body: string): string {
  const parsed = ts.createSourceFile('tools-manager.ts', body, ts.ScriptTarget.Latest, true);
  const names = new Set(['extractZipArchive', 'getWindowsTarCommand']);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === 'getWindowsTarCommand' ||
        (node.text === 'extractZipArchive' && (!ts.isCallExpression(node.parent) || node.parent.expression !== node)))) {
      throw new Error('Native ZIP extraction reference changed');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'extractZipArchive') {
      if (!ts.isExpressionStatement(node.parent) ||
          node.arguments.map(argument => argument.getText(parsed)).join(',') !== 'archivePath,extractDir,assetName') {
        throw new Error('Native ZIP extraction call changed');
      }
      edits.push({ start: node.getStart(parsed), end: node.getStart(parsed), text: 'await ' });
      calls++;
    }
    ts.forEachChild(node, visit);
  };
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && names.delete(node.name.text)) {
      const parameters = node.name.text === 'extractZipArchive' ? 'archivePath,extractDir,assetName' : '';
      const result = node.name.text === 'extractZipArchive' ? 'void' : 'string';
      if (node.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== parameters ||
          node.parameters.some(parameter => parameter.type?.kind !== ts.SyntaxKind.StringKeyword) ||
          node.type?.getText(parsed) !== result || node.modifiers?.length) {
        throw new Error('Native ZIP extraction boundary changed');
      }
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    } else visit(node);
  }
  if (names.size || calls !== 1) throw new Error('Native ZIP extraction declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { extractZipArchive } from "../../compat/archive.ts";\n' + body;
}

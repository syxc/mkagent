import { createHash } from 'node:crypto';
import ts from 'typescript';

const hashes: Record<string, string> = {
  detectLineEnding: '9e8c1ebbbf23147115208a767d6115c440722c86f8a69ed9fa31474d67d8de8f',
  normalizeToLF: 'a70a472447a9d7709a8e1f4d0de5e4469e8ecd7770e22b45cfe0fbe3a383fa7c',
  restoreLineEndings: 'a6e568978b4f01378d66670798072c26c3b841c5fe46f9ef3153ec19450077a8',
  normalizeForFuzzyMatch: '6d0ebd6a0268046ce0ab45637e86ee5db0786f049d7de0c52fc7e0bdfa1c3151',
  splitLinesWithEndings: '929cefca4129bc76bffb037e6dad5c2447fddd3b05839f82e5ebe85dfe7cbf4c',
  LineSpan: '8052301ef43cf27450f3aedd8e07a1bc352782d2e40d852d08d48160bc1cf1aa',
  getLineSpans: 'dd06ccf996fafeeaf8bffe1f3963a25c300b07854e047180f597277b65f08946',
  getReplacementLineRange: '1d4a8f60abea2ef489eda5cc4b45acad9dcdacf6fa0de25df600be304fd862f2',
  applyReplacements: '7f31f3245591d649b7e5ba6d26e3bd3aad88fda9efddea9bd82994e1cbd338e4',
  applyReplacementsPreservingUnchangedLines: '3a83602d7e7be2ebf8197237996e78930fa52a6202b63693248bbb91576c126e',
  fuzzyFindText: 'a81049eb83eaa46b1c549942fa078943fe0cd0fab9be61b27bb53b503c462c93',
  countOccurrences: '61e2a87e72bf3cab0fdd68a74fe59f29d5a7a4e2da666d953fe125fcb39422b4',
  getNotFoundError: '01c47ef189bdc080a34ef4b8508444f2529b34aa22d8cffb8d9e0e8e97ba6b14',
  getDuplicateError: '018703285c303dac2d6c73ae3d144c30dc300d7bb58e2f2e12bde7c0e30c45c9',
  getEmptyOldTextError: '2deb61a8f27db6d8fe5b14912fb34cb88601ded5f9754a3ae31ca472f35d8737',
  getNoChangeError: '57d53d4a377c3134164eeeeaea3d9af656eef9fef287e5387d6af12e3c42b6d2',
  applyEditsToNormalizedContent: '4e5e5fe5fea1d1cb8c0d9d7f4202c9648e78cf9d5c05eec51c1f7ae8b4224b42',
  generateUnifiedPatch: 'fdb7cd7735d3a81c21dc1241ef8906c2e317de328d342c2e4e62b3f6e5e060ca',
  generateDiffString: '33eb0304439ef20355cd46faf0060bebc54ce270fbf861ea4f0a7ffed7bbedb4',
};
export function portEditDiff(body: string): string {
  const parsed = ts.createSourceFile('edit-diff.ts', body, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const seen = new Set<string>();
  let imports = 0;
  for (const node of parsed.statements) {
    if (ts.isImportDeclaration(node) && node.getText(parsed) === 'import * as Diff from "diff";') {
      edits.push({ start: node.getStart(parsed), end: node.end,
        text: 'import * as sharedEdit from "@earendil-works/pi-durable/tools";' });
      imports++;
    }
    const name = ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ? node.name?.text : undefined;
    if (!name || !Object.hasOwn(hashes, name)) continue;
    if (seen.has(name) || createHash('sha256').update(node.getText(parsed)).digest('hex') !== hashes[name]) {
      throw new Error(`Upstream edit diff declaration changed: ${name}`);
    }
    seen.add(name);
    if (ts.isFunctionDeclaration(node) && node.body &&
        node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const args = node.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
          throw new Error(`Unsupported edit diff parameter: ${name}`);
        }
        return parameter.name.text;
      }).join(', ');
      edits.push({ start: node.body.getStart(parsed), end: node.body.end,
        text: `{\n\treturn sharedEdit.${name}(${args});\n}` });
    } else {
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    }
  }
  if (seen.size !== Object.keys(hashes).length || imports !== 1) {
    throw new Error('Upstream edit diff declarations or diff import changed');
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  }
  return body;
}

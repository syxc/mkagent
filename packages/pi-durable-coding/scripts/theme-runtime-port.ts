import ts from 'typescript';

function replaceOnce(body: string, before: string, after: string): string {
  if (body.split(before).length !== 2) throw new Error('Pinned theme boundary changed');
  return body.replace(before, after);
}

function removeDeclarations(body: string, names: string[]): string {
  const parsed = ts.createSourceFile('theme.ts', body, ts.ScriptTarget.Latest, true);
  const remaining = new Set(names);
  const edits: ts.Statement[] = [];
  for (const statement of parsed.statements) {
    const name = ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
      ? statement.declarationList.declarations[0]?.name
      : ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ? statement.name : undefined;
    if (!name || !ts.isIdentifier(name) || !names.includes(name.text)) continue;
    if (!remaining.delete(name.text)) throw new Error('Pinned theme declaration repeated');
    edits.push(statement);
  }
  if (remaining.size) throw new Error('Pinned theme declarations changed: ' + [...remaining].join(', '));
  for (const node of edits.reverse()) body = body.slice(0, node.getFullStart()) + body.slice(node.end);
  return body;
}

function portIndexedTheme(body: string): string {
  const parsed = ts.createSourceFile('system-theme.ts', body, ts.ScriptTarget.Latest, true);
  const declaration = (name: string) => {
    const found = parsed.statements.filter(node =>
      ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 &&
        node.declarationList.declarations[0]?.name.getText(parsed) === name ||
      (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name?.text === name);
    if (found.length !== 1) throw new Error('Pinned system theme declaration changed: ' + name);
    return found[0]!;
  };
  const familyStatement = declaration('FAMILIES');
  if (!ts.isVariableStatement(familyStatement)) throw new Error('Pinned theme families changed');
  const expression = familyStatement.declarationList.declarations[0]?.initializer;
  if (!expression || !ts.isSatisfiesExpression(expression) || !ts.isObjectLiteralExpression(expression.expression)) {
    throw new Error('Pinned theme families changed');
  }
  const slots = expression.expression.properties.map(family => {
    if (!ts.isPropertyAssignment(family) || !ts.isObjectLiteralExpression(family.initializer)) {
      throw new Error('Pinned theme family changed');
    }
    const slot = family.initializer.properties.filter(property => property.name?.getText(parsed) === 'slot');
    if (slot.length !== 1 || !ts.isPropertyAssignment(slot[0]!) || !ts.isNumericLiteral(slot[0]!.initializer)) {
      throw new Error('Pinned theme family slot changed');
    }
    return '\t' + family.name.getText(parsed) + ': ' + slot[0]!.initializer.text + ',';
  });
  const generation = declaration('generateSystemThemeColors').getText(parsed);
  if (!generation.includes('if (!background) return indexedColors(saturation, input.appearanceHint);')) {
    throw new Error('Pinned system theme fallback changed');
  }
  let indexed = declaration('indexedColors').getText(parsed);
  indexed = replaceOnce(indexed, 'function indexedColors(saturation: number, appearance: ThemeAppearance | undefined)',
    'export function generateSystemThemeColors(appearance: ThemeAppearance)');
  indexed = replaceOnce(indexed, '!neutral && saturation > 0', '!neutral');
  indexed = replaceOnce(indexed, 'FAMILIES[familyName].slot', 'FAMILY_SLOTS[familyName]');
  return [
    '// Use the terminal palette; this host does not request terminal color reports.',
    'import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme.ts";',
    declaration('SYSTEM_THEME_NAME').getText(parsed),
    'const FAMILY_SLOTS = {\n' + slots.join('\n') + '\n} as const;',
    'type FamilyName = keyof typeof FAMILY_SLOTS;',
    ...['TOKEN_FAMILIES', 'TOKEN_SLOTS', 'PANELS', 'FOREGROUND_TOKENS', 'SystemThemeColors'].map(name => declaration(name).getText(parsed)),
    indexed,
  ].join('\n\n') + '\n';
}

export function portThemeRuntime(path: string, body: string): { body: string; change: string } | undefined {
  if (path === 'modes/interactive/theme/system-theme.ts') {
    return { body: portIndexedTheme(body), change: 'exclude-terminal-color-report-solver' };
  }
  if (path === 'modes/interactive/theme/theme-schema.ts') {
    const end = body.indexOf(' */\n');
    if (!body.startsWith('/**\n * Theme JSON validation,') || end < 0) throw new Error('Pinned theme schema comment changed');
    return { body: '/** Validate user-authored themes at every file-loading entry point. */' + body.slice(end + 3),
      change: 'validate-themes-at-resource-boundary' };
  }
  if (path !== 'modes/interactive/theme/theme.ts') return undefined;
  body = removeDeclarations(body, [
    'ThemeJsonValidator', 'themeJsonValidator', 'setThemeJsonValidator', 'parseThemeJson',
    'terminalColors', 'terminalColorsPending', 'terminalColorScheme',
    'setTerminalColors', 'setTerminalColorScheme', 'markTerminalColorsPending', 'detectTerminalTheme',
  ]);
  const replacements = [
    ['\ttype RgbColor,\n\trgbColor,\n', ''],
    ['\ttype TerminalColors,\n', ''],
    ['generateSystemThemeColors, SYSTEM_THEME_NAME, terminalAppearance', 'generateSystemThemeColors, SYSTEM_THEME_NAME'],
    ['/** The schema that validates this shape lives in `theme-schema.ts`; importing the type is free. */\nimport type { ThemeColorValue as ColorValue, ValidatedThemeJson as ThemeJson }',
      'import { validateThemeJson, type ThemeColorValue as ColorValue, type ValidatedThemeJson as ThemeJson }'],
    ['return parseThemeJson(label, json);', 'return validateThemeJson(label, json);'],
    ['private resolvedColors: { terminal: TerminalColors; colors: Readonly<Record<ThemeToken, Color>> } | undefined;',
      'private resolvedColors: Readonly<Record<ThemeToken, Color>> | undefined;'],
    ['Concrete colors for all tokens. Tokens set to "" (terminal default) use the terminal\'s reported\n\t * default colors, or a guess based on `appearance` when the terminal did not report them. Faint',
      'Concrete colors for all tokens. Tokens set to "" use defaults based on `appearance`. Faint'],
    ['\t\tconst terminal = terminalColors;\n\t\tif (this.resolvedColors?.terminal !== terminal) {\n\t\t\tconst guess = GUESSED_DEFAULT_COLORS[this.appearance];\n\t\t\tconst toColor = (rgb: RgbColor | undefined, fallback: Color) =>\n\t\t\t\trgb ? rgbColor(rgb.r, rgb.g, rgb.b) : fallback;\n\t\t\tconst foreground = toColor(terminal.foreground, guess.foreground);\n\t\t\tconst background = toColor(terminal.background, guess.background);',
      '\t\tif (!this.resolvedColors) {\n\t\t\tconst { foreground, background } = GUESSED_DEFAULT_COLORS[this.appearance];'],
    ['this.resolvedColors = { terminal, colors: Object.freeze(colors as Record<ThemeToken, Color>) };',
      'this.resolvedColors = Object.freeze(colors as Record<ThemeToken, Color>);'],
    ['return this.resolvedColors.colors;', 'return this.resolvedColors;'],
    ['/** Generate the system theme from the terminal\'s reported colors (grayscale while they are pending). */',
      '/** Use the terminal palette without requesting terminal color reports. */'],
    ['generateSystemThemeColors({\n\t\t...terminalColors,\n\t\tsaturation: terminalColorsPending ? 0 : 1,\n\t\tappearanceHint: getTerminalTheme(),\n\t})', 'generateSystemThemeColors(getTerminalTheme())'],
    ['/** Whether the terminal is dark or light, from everything it reported so far. See `detectTerminalTheme()`. */',
      '/** Resolve the terminal appearance from COLORFGBG, with a dark default. */'],
    ['return detectTerminalTheme(terminalColors, terminalColorScheme);', 'return detectColorFgBgTheme() ?? "dark";'],
  ];
  for (const [before, after] of replacements) body = replaceOnce(body, before!, after!);
  return { body, change: 'resource-theme-validation-without-terminal-reports' };
}

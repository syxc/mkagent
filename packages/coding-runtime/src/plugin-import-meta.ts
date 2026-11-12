import { basename, dirname } from 'node:path';

interface MemberPath {
  node: {
    object: { type: string; meta?: { name: string }; property?: { name: string } };
    property: { type: string; name?: string; value?: unknown };
    computed: boolean;
  };
  replaceWith(node: { type: 'StringLiteral'; value: string }): void;
}

/** Jiti handles standard metadata; Bun aliases must use the source file, not its data URL wrapper. */
export function pluginImportMeta() {
  const replace = (path: MemberPath, state: { opts: { filename?: string } }) => {
    const { object, property, computed } = path.node;
    if (object.type !== 'MetaProperty' || object.meta?.name !== 'import' || object.property?.name !== 'meta') return;
    const key = computed ? property.type === 'StringLiteral' ? property.value : undefined : property.name;
    if (key !== 'dir' && key !== 'path' && key !== 'file') return;
    const filename = state.opts.filename;
    if (!filename) throw new Error('Plugin import metadata requires its source filename');
    path.replaceWith({
      type: 'StringLiteral',
      value: key === 'dir' ? dirname(filename) : key === 'file' ? basename(filename) : filename,
    });
  };
  return { name: 'mkagent-plugin-import-meta', visitor: { MemberExpression: replace, OptionalMemberExpression: replace } };
}

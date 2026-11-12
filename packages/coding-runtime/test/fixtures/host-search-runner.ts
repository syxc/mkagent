import { createLsToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  createFindTool, createFindToolDefinition, createGrepTool, createGrepToolDefinition,
} from '../../src/native-search-tools.ts';

const cwd = process.argv[2]!;
const context = { cwd } as ExtensionContext;
const grep = createGrepToolDefinition('/unused');
const find = createFindToolDefinition('/unused');
const ls = createLsToolDefinition('/unused');
const grepResult = await grep.execute('grep', { pattern: 'needle' }, undefined, undefined, context);
const findResult = await find.execute('find', { pattern: '*.txt' }, undefined, undefined, context);
const lsResult = await ls.execute('ls', {}, undefined, undefined, context);
const agentGrep = await createGrepTool(cwd).execute('agent-grep', { pattern: 'needle' });
const agentFind = await createFindTool(cwd).execute('agent-find', { pattern: '*.txt' });
if (JSON.stringify(agentGrep) !== JSON.stringify(grepResult) || JSON.stringify(agentFind) !== JSON.stringify(findResult)) {
  throw new Error('Agent tool and tool definition results differ');
}
console.log(JSON.stringify({
  grep: grepResult, find: findResult, ls: lsResult,
  renderers: [grep, find, ls].every(tool => typeof tool.renderCall === 'function' && typeof tool.renderResult === 'function'),
}));

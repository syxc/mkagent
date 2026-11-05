/** The same plugin drives native-reference and durable-product session checks. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.registerCommand('contract-idle', { handler: async (_args, ctx) => { await ctx.waitForIdle(); } });
  pi.registerCommand('contract-new', { handler: async (_args, ctx) => {
    await ctx.newSession({ withSession: async next => { await next.sendUserMessage('contract new callback'); } });
  } });
  pi.registerCommand('contract-fork', { handler: async (args, ctx) => {
    await ctx.fork(args.trim(), { position: 'at',
      withSession: async next => { await next.sendUserMessage('contract fork callback'); } });
  } });
  pi.registerCommand('contract-switch', { handler: async (args, ctx) => {
    await ctx.switchSession(args.trim(), {
      withSession: async next => { await next.sendUserMessage('contract switch callback'); },
    });
  } });
  pi.registerCommand('contract-tree', { handler: async (args, ctx) => {
    const entryId = args.trim() || ctx.sessionManager.getBranch().findLast(entry =>
      entry.type === 'message' && entry.message.role === 'user')?.id;
    if (!entryId) return;
    const result = await ctx.navigateTree(entryId);
    if (!result.cancelled && result.editorText !== undefined) ctx.ui.setEditorText(result.editorText);
  } });
  pi.registerCommand('contract-reload', { handler: async (_args, ctx) => { await ctx.reload(); } });
}

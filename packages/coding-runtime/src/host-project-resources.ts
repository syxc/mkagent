/** Resolve host project trust before native resources or project MCP configuration can execute. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHostResources, type HostResourceOptions } from './host-resources.ts';
import { emitProjectTrustEvent } from '@earendil-works/pi-coding-agent';
import type { LoadExtensionsResult, ProjectTrustContext } from '@earendil-works/pi-coding-agent';
import {
  getProjectTrustOptions, hasTrustRequiringProjectResources, ProjectTrustStore,
} from '@earendil-works/pi-coding-agent';

/** Load trusted resources once and keep the same decision boundary on native reload. */
export async function prepareHostResources(
  options: HostResourceOptions,
  getContext: () => ProjectTrustContext,
  onError: (message: string) => void,
  onTrustResolved?: (trusted: boolean) => Promise<void>,
): Promise<ReturnType<typeof createHostResources>> {
  const automatic = options.resourcePolicy !== 'host-only' && options.projectTrusted === undefined;
  const store = automatic ? new ProjectTrustStore(options.agentDir) : undefined;
  let sessionTrusted: boolean | undefined;
  const resolveProjectTrust = async ({ extensionsResult }: { extensionsResult: LoadExtensionsResult }): Promise<boolean> => {
    const required = hasTrustRequiringProjectResources(options.cwd)
      || existsSync(join(options.cwd, '.mkagent', 'mcp.json'));
    if (!required) return store!.get(options.cwd) ?? true;
    const context = getContext();
    const { result, errors } = await emitProjectTrustEvent(extensionsResult,
      { type: 'project_trust', cwd: options.cwd }, context);
    for (const error of errors) onError(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
    if (result) {
      const trusted = result.trusted === 'yes';
      if (result.remember === true) store!.set(options.cwd, trusted);
      return trusted;
    }
    const remembered = store!.get(options.cwd);
    if (remembered !== null) return remembered;
    if (sessionTrusted !== undefined) return sessionTrusted;
    const policy = resources.settingsManager.getDefaultProjectTrust();
    if (policy === 'always') return true;
    if (policy === 'never' || !context.hasUI) return false;
    const choices = getProjectTrustOptions(options.cwd, { includeSessionOnly: true });
    const choice = await context.ui.select(
      `Trust project folder?\n${options.cwd}\n\nThis allows MkAgent to load project settings and resources and execute project extensions and MCP servers. Missing packages are not installed.`,
      choices.map(choice => choice.label),
    );
    const selected = choices.find(candidate => candidate.label === choice);
    if (!selected) return false;
    if (selected.updates.length) store!.setMany(selected.updates);
    else sessionTrusted = selected.trusted;
    return selected.trusted;
  };
  const resources = createHostResources({
    ...options,
    projectTrusted: options.projectTrusted ?? false,
    ...(automatic ? { resolveProjectTrust: async input => {
      const trusted = await resolveProjectTrust(input);
      await onTrustResolved?.(trusted);
      return trusted;
    } } : {}),
  });
  await resources.resourceLoader.reload();
  return resources;
}

/** Explicit native package operations share host settings and project trust. */
import type { ExtensionFactory } from './pi/core/extensions/types.ts';
import { DefaultPackageManager } from './pi/core/package-manager.ts';
import { parseCommandArgs } from './pi/core/prompt-templates.ts';
import type { SettingsManager } from './pi/core/settings-manager.ts';

const usage = '/packages list|install|remove|update [--local] [source]';

export function createHostPackageExtension(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}): ExtensionFactory {
  return pi => {
    const settings = options.settingsManager;
    const packages = new DefaultPackageManager({
      ...options,
      resolutionPolicy: { legacyGlobalPackages: false, commandOutput: 'stderr' },
    });
    let accepting = true;
    let pending = Promise.resolve();
    const flush = async () => {
      await settings.flush();
      const errors = settings.drainErrors();
      if (errors.length) throw new Error(errors.map(entry => `${entry.scope}: ${entry.error.message}`).join('\n'));
    };
    pi.on('session_shutdown', async () => {
      accepting = false;
      // Native installers have no cancellation contract. Finish before ownership changes.
      await pending;
      await settings.flush();
    });
    pi.registerCommand('packages', {
      description: 'List, install, remove or update Pi packages; --local selects the trusted project',
      handler: async (args, ctx) => {
        let mutationStarted = false;
        try {
          if (!accepting) throw new Error('Package owner is closing');
          const [action = 'list', ...rest] = parseCommandArgs(args);
          const local = rest.includes('--local') || rest.includes('-l');
          const sources = rest.filter(value => value !== '--local' && value !== '-l');
          const source = sources[0];
          if (!['list', 'install', 'remove', 'update'].includes(action) || sources.length > 1
            || (action === 'list' && source !== undefined)
            || ((action === 'install' || action === 'remove') && !source)) throw new Error(usage);
          const operation = pending.then(async () => {
            if (!accepting) throw new Error('Package owner is closing');
            await flush();
            // Other owners and failed writes can leave this session's snapshot stale.
            await settings.reload();
            await flush();
            if (!accepting) throw new Error('Package owner is closing');
            if (local && !settings.isProjectTrusted()) throw new Error('Project is not trusted; reload and approve project trust first');
            if (action === 'list') {
              const entries = packages.listConfiguredPackages().filter(entry => entry.scope === (local ? 'project' : 'user'));
              ctx.ui.notify(entries.length ? entries.map(entry =>
                `${entry.scope}: ${entry.source}${entry.installedPath ? '' : ' (not installed)'}`).join('\n')
                : `No ${local ? 'project' : 'user'} packages configured`, 'info');
              return false;
            }
            ctx.ui.notify(`Package ${action} started (${local ? 'project' : 'user'} scope)`, 'info');
            mutationStarted = true;
            if (action === 'install') await packages.installAndPersist(source!, { local });
            else if (action === 'remove') await packages.removeAndPersist(source!, { local });
            else await packages.update(source, { local });
            await flush();
            return true;
          });
          pending = operation.then(() => {}, () => {});
          if (!await operation || !accepting) return;
          ctx.ui.notify(`Package ${action} completed. Reloading resources.`, 'info');
          // Reload retires this command context. The shutdown hook must see a settled operation.
          await ctx.reload();
        } catch (error) {
          if (accepting) ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}${mutationStarted
            ? '\nPackage files may have changed. Use /packages list to check configured sources.' : ''}`, 'error');
        }
      },
    });
  };
}

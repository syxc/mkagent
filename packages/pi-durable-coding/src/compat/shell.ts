import { createShellHelpers, type ShellHelpers } from '@earendil-works/pi-coding-agent';
import { getBashShellConfig, killProcessTree as killTree } from '@earendil-works/pi-durable/env/node';
import { getBinDir } from '../pi/config.ts';

export { getBashShellConfig };
export type { ShellConfig } from '@earendil-works/pi-coding-agent';

const helpers = createShellHelpers({ getBinDir, getBashShellConfig, killProcessTree });
export const getShellConfig: ShellHelpers['getShellConfig'] = helpers.getShellConfig;
export const getPowerShellConfig: ShellHelpers['getPowerShellConfig'] = helpers.getPowerShellConfig;
export const getShellEnv: ShellHelpers['getShellEnv'] = helpers.getShellEnv;
export const trackDetachedChildPid: ShellHelpers['trackDetachedChildPid'] = helpers.trackDetachedChildPid;
export const untrackDetachedChildPid: ShellHelpers['untrackDetachedChildPid'] = helpers.untrackDetachedChildPid;
export const killTrackedDetachedChildren: ShellHelpers['killTrackedDetachedChildren'] = helpers.killTrackedDetachedChildren;

export function killProcessTree(pid: number): void {
  if (process.platform === 'darwin') {
    // Stop the group before a killed child can wake its shell and start another command (#11252).
    try {
      process.kill(-pid, 'SIGSTOP');
    } catch {
      // A failed stop must not prevent group killing or its child fallback.
    }
  }
  killTree(pid);
}

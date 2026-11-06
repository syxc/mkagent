import { killProcessTree as killTree } from '@earendil-works/pi-durable/env/node';
export { getBashShellConfig } from '@earendil-works/pi-durable/env/node';

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

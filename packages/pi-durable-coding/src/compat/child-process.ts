import type { ChildProcess } from 'node:child_process';
import { waitForChildProcess as wait } from '@earendil-works/pi-durable/env/node';

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return wait(child, () => false).then(result => result.code);
}

import { readPathVariants } from '@earendil-works/pi-durable/tools';

function* nativeVariants(resolved: string): IterableIterator<string> {
  // Native skips unchanged spellings but retries duplicates of other fallbacks.
  let first = true;
  for (const variant of readPathVariants(resolved)) {
    if (first || variant !== resolved) yield variant;
    first = false;
  }
}

export function findReadPath(resolved: string, exists: (path: string) => boolean): string {
  for (const variant of nativeVariants(resolved)) {
    if (exists(variant)) return variant;
  }
  return resolved;
}

export async function findReadPathAsync(
  resolved: string, exists: (path: string) => Promise<boolean>,
): Promise<string> {
  for (const variant of nativeVariants(resolved)) {
    if (await exists(variant)) return variant;
  }
  return resolved;
}

/**
 * Craft's "Compact context at" (config.json `autoCompactWindow`) as a compaction
 * reserve. Pi has no threshold setting of its own: it compacts once context
 * exceeds `contextWindow − reserveTokens`, so the threshold becomes a per-model
 * reserve. Never below Pi's own reserve: a window at or beyond the model's limit
 * keeps Pi's default trigger.
 */
const isPositiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

export function compactionReserveFor(
  contextWindow: unknown,
  baseReserve: number,
  autoCompactWindow: number | undefined,
): number {
  if (!isPositiveInt(contextWindow) || !isPositiveInt(autoCompactWindow)) return baseReserve;
  return Math.max(baseReserve, contextWindow - autoCompactWindow);
}

/** Convert the host threshold to Pi's reserve without reducing the native safety margin. */
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

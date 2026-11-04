/**
 * Craft's "Compact context at" (config.json `autoCompactWindow`) as a compaction
 * reserve. Pi has no threshold setting of its own: it compacts once context
 * exceeds `contextWindow − reserveTokens`, so the threshold becomes a per-model
 * reserve. Never below Pi's own reserve: a window at or beyond the model's limit
 * keeps Pi's default trigger.
 */
export { compactionReserveFor } from '@mkagent/pi-durable-coding/native';

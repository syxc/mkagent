import {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead as sharedHead,
  type TruncationOptions, type TruncationResult,
} from '@earendil-works/pi-durable/tools';

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  // Native validates non-text input through Buffer before splitting it.
  if (typeof content !== 'string') Buffer.byteLength(content, 'utf-8');
  if (content.length === 0 && !(0 <= maxLines && 0 <= maxBytes)) {
    // Native reports Buffer's missing-first-line error for these invalid limits.
    Reflect.apply(Buffer.byteLength, Buffer, [undefined, 'utf-8']);
  }
  const result = sharedHead(content, { maxLines, maxBytes });
  if (result.truncated && !result.firstLineExceedsLimit &&
      ((result.outputLines >= maxLines && result.outputBytes <= maxBytes) ||
       result.outputLines === result.totalLines)) {
    // Native labels a dropped trailing newline as a line truncation.
    return { ...result, truncatedBy: 'lines' };
  }
  return result;
}

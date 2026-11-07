import {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead as sharedHead,
  type TruncationOptions, type TruncationResult,
} from '@earendil-works/pi-durable/tools';
import { boundOutput } from '@earendil-works/chord/output';

export function splitLinesForCounting(content: string): string[] {
  return content.length === 0 ? [] : content.split('\n').slice(0, content.endsWith('\n') ? -1 : undefined);
}

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

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  const result: TruncationResult = {
    content, truncated: false, truncatedBy: null, totalLines, totalBytes,
    outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false,
    firstLineExceedsLimit: false, maxLines, maxBytes,
  };
  if (totalLines <= maxLines && totalBytes <= maxBytes) return result;
  const lineLimit = maxLines > 0 ? Math.ceil(Number(maxLines)) : 0;
  const byteLimit = Number.isNaN(Number(maxBytes)) ? Infinity : Math.max(0, Number(maxBytes));
  const partial = totalLines > 0 && lineLimit > 0 && Buffer.byteLength(lines.at(-1)!, 'utf-8') > maxBytes;
  let outputLines = 0, outputContent = '';
  if (partial) {
    outputLines = 1;
    if (!Number.isInteger(0 - maxBytes)) {
      // Native passes fractional offsets to Buffer without aligning their UTF-8 boundary.
      const bytes = Buffer.from(lines.at(-1)!, 'utf-8');
      outputContent = bytes.subarray(bytes.length - maxBytes).toString('utf-8');
    } else {
      // A UTF-8 byte window cannot retain more UTF-16 code units than its byte limit.
      const suffix = byteLimit > 0 ? lines.at(-1)!.slice(-byteLimit) : '';
      outputContent = boundOutput(suffix, {
        maxBytes: byteLimit, maxLines: Infinity, retain: 'tail',
      }).text;
    }
  } else if (lineLimit > 0 && totalLines > 0) {
    const candidates = lineLimit < totalLines ? lines.slice(-lineLimit) : lines;
    const normalized = candidates.join('\n');
    // Select original lines by Native byte weights, including Bun's lone-surrogate accounting.
    const windowText = /[\uD800-\uDFFF]/u.test(normalized)
      ? candidates.map(line => 'x'.repeat(Buffer.byteLength(line))).join('\n') : normalized;
    // The marker makes a final empty Native line count without consuming its byte allowance.
    const bounded = boundOutput(`${windowText}\0`, {
      maxLines: lineLimit, maxBytes: Math.floor(byteLimit) + 1, retain: 'tail',
    });
    outputLines = candidates.length - bounded.droppedLines;
    outputContent = candidates.slice(-outputLines).join('\n');
  }
  const outputBytes = Buffer.byteLength(outputContent, 'utf-8');
  const next = lines[totalLines - outputLines - 1];
  const byteLimited = partial || outputLines < lineLimit && next !== undefined &&
    outputBytes + Buffer.byteLength(next, 'utf-8') + (outputLines > 0 ? 1 : 0) > maxBytes;
  return {
    ...result, content: outputContent, truncated: true,
    truncatedBy: outputLines >= maxLines && outputBytes <= maxBytes ? 'lines' : byteLimited ? 'bytes' : 'lines',
    outputLines, outputBytes, lastLinePartial: partial,
  };
}

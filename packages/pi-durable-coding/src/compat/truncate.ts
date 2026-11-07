import { boundOutput } from '@earendil-works/chord/output';
import type { TruncationOptions, TruncationResult } from '../pi/core/tools/truncate.ts';

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  return truncate(content, options, 'head');
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  return truncate(content, options, 'tail');
}

function truncate(content: string, options: TruncationOptions, retain: 'head' | 'tail'): TruncationResult {
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
  // Head retention never returns a partial line, including with a zero line limit.
  if (retain === 'head' && Buffer.byteLength(lines[0], 'utf-8') > maxBytes) {
    return { ...result, content: '', truncated: true, truncatedBy: 'bytes',
      outputLines: 0, outputBytes: 0, firstLineExceedsLimit: true };
  }
  const lineLimit = maxLines > 0 ? Math.ceil(Number(maxLines)) : 0;
  const byteLimit = Number.isNaN(Number(maxBytes)) ? Infinity : Math.max(0, Number(maxBytes));
  const partial = retain === 'tail' && totalLines > 0 && lineLimit > 0 &&
    Buffer.byteLength(lines.at(-1)!, 'utf-8') > maxBytes;
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
        maxBytes: byteLimit, maxLines: Infinity, retain,
      }).text;
    }
  } else if (lineLimit > 0 && totalLines > 0) {
    const candidates = lineLimit < totalLines
      ? retain === 'head' ? lines.slice(0, lineLimit) : lines.slice(-lineLimit) : lines;
    const normalized = candidates.join('\n');
    // Select original lines by Native byte weights, including Bun's lone-surrogate accounting.
    const windowText = /[\uD800-\uDFFF]/u.test(normalized)
      ? candidates.map(line => 'x'.repeat(Buffer.byteLength(line))).join('\n') : normalized;
    // The marker counts a final empty line. The extra byte also allows head's dropped final newline.
    const bounded = boundOutput(`${windowText}\0`, {
      maxLines: lineLimit, maxBytes: Math.floor(byteLimit) + 1, retain,
    });
    outputLines = candidates.length - bounded.droppedLines;
    outputContent = (retain === 'head' ? candidates.slice(0, outputLines) : candidates.slice(-outputLines)).join('\n');
  }
  const outputBytes = Buffer.byteLength(outputContent, 'utf-8');
  const next = lines[retain === 'head' ? outputLines : totalLines - outputLines - 1];
  const byteLimited = partial || outputLines < lineLimit && next !== undefined &&
    outputBytes + Buffer.byteLength(next, 'utf-8') + (outputLines > 0 ? 1 : 0) > maxBytes;
  return {
    ...result, content: outputContent, truncated: true,
    truncatedBy: outputLines >= maxLines && outputBytes <= maxBytes ? 'lines' : byteLimited ? 'bytes' : 'lines',
    outputLines, outputBytes, lastLinePartial: partial,
  };
}

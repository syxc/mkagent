import { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, formatSize as sharedFormatSize } from "@earendil-works/pi-durable/tools";
import { truncateHead as sharedTruncateHead, truncateTail as sharedTruncateTail, splitLinesForCounting } from "../../../compat/truncate.ts";
export { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES };
/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	return sharedFormatSize(bytes);
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	return sharedTruncateHead(content, options);
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	return sharedTruncateTail(content, options);
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

export interface MiddleTruncationResult {
	/** The start and end of the content with a `…N chars truncated…` marker between them. */
	content: string;
	truncated: boolean;
	/** Characters left out. */
	removedChars: number;
	totalBytes: number;
	totalLines: number;
}

/**
 * Keep the start and the end of `content`, half of `maxBytes` each, and replace the middle with a
 * `…N chars truncated…` marker, like Codex does for tool output. Cuts only at character boundaries.
 */
export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
	const buf = Buffer.from(content, "utf-8");
	const totalLines = splitLinesForCounting(content).length;
	if (buf.length <= maxBytes) {
		return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
	}
	// Continuation bytes (10xxxxxx) are not character starts.
	const isBoundary = (index: number) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	let headEnd = Math.floor(maxBytes / 2);
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
	return {
		content: `${head}…${removedChars} chars truncated…${tail}`,
		truncated: true,
		removedChars,
		totalBytes: buf.length,
		totalLines,
	};
}

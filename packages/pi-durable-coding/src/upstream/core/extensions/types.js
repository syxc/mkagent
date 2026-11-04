// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */
/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
export function defineTool(tool) {
    return tool;
}
// Type guards for ToolResultEvent
export function isBashToolResult(e) {
    return e.toolName === "bash";
}
export function isPowerShellToolResult(e) {
    return e.toolName === "powershell";
}
export function isReadToolResult(e) {
    return e.toolName === "read";
}
export function isEditToolResult(e) {
    return e.toolName === "edit";
}
export function isWriteToolResult(e) {
    return e.toolName === "write";
}
export function isGrepToolResult(e) {
    return e.toolName === "grep";
}
export function isFindToolResult(e) {
    return e.toolName === "find";
}
export function isLsToolResult(e) {
    return e.toolName === "ls";
}
export function isToolCallEventType(toolName, event) {
    return event.toolName === toolName;
}

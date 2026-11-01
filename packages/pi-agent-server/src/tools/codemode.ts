/**
 * The codemode tool for the kernel: pi-durable's built-in code mode extension, bound to the Node
 * sandbox from `@earendil-works/pi-codemode`. Scripts call the conversation's callable tools as
 * `tools.<name>(args)`; MCP servers reach them through the namespaces passed here.
 */
import type { Extension } from '@earendil-works/pi-durable';
import { createCodemodeExtension, type CodemodeNamespace } from '@earendil-works/pi-durable/codemode';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';

/**
 * Create the codemode extension with the given tool namespaces (MCP servers, if any).
 *
 * Note for bundling: the sandbox resolves `quickjs-wasi/quickjs.wasm` and its worker relative to
 * the installed packages. If the subprocess bundle stops resolving them, pass `wasm` and
 * `workerUrl` explicitly, as the coding agent's codemode extension does.
 */
export function createCodemodeExtensionFor(namespaces: readonly CodemodeNamespace[] = []): Extension {
  return createCodemodeExtension({ sandbox: new CodemodeSandbox(), namespaces });
}

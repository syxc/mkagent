/**
 * Tool wrapping for the durable kernel: permission enforcement, MkAgent UI
 * metadata plumbing, background bash, and large-response summarization.
 *
 * Same contract as the 1.1.0 `wrapSingleTool`, adapted to durable's
 * `ToolRegistration`: arguments are checked by the host main process through
 * the `pre_tool_use` handshake before the tool runs, metadata never reaches
 * the tool implementation, and oversized tool output is summarized through
 * the mini model.
 */
import type { ToolRegistration, ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { estimateTokens, handleLargeResponse, tokenLimitFor } from '../../../shared/src/utils/large-response.ts';
import { getSessionPath } from '../../../shared/src/sessions/storage.ts';
import { PI_TOOL_NAME_MAP } from '../../../shared/src/agent/backend/pi/constants.ts';
import { allowMkAgentMetadataProperties, stripMkAgentMetadata } from '../mkagent-metadata-schema.ts';
import type { BackgroundShells } from '../background-shell.ts';
import { resolveReadPath, resolveToCwd } from './local/path-utils.ts';

export interface ToolWrapDeps {
  /** Main-process permission check; resolves the (possibly modified) input, throws on block. */
  requestApproval(toolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<Record<string, unknown>>;
  backgroundShells: BackgroundShells;
  /** Directory for background task output files (`<agentDir>/tasks`). */
  tasksDirectory: string;
  /**
   * Execution env for background bash. Durable's own bash tool is unusable
   * here: its api asserts the tool call is still live, and a background task
   * outlives the call that started it.
   */
  shellEnv: NodeExecutionEnv;
  /** Active model's context window (tracks set_model mid-session). */
  getContextWindow(): number | undefined;
  /** Mini-model summarizer for oversized tool output. */
  summarize(text: string): Promise<string | null>;
  /** Latest user request, used as summarization context. */
  getUserRequest(): string;
  /** Where large tool responses spill. Null disables spilling. */
  getSessionPath(): string | null;
  debugLog(message: string): void;
}

type AnyTool = ToolRegistration<any, any>;

/** Background execution runs with its own signal and accumulates output into the task file. */
function backgroundContext(signal: AbortSignal): Context {
  return {
    abortSignal: signal,
    telemetry: BACKGROUND_CONTEXT.telemetry,
    value: () => undefined,
    toString: () => 'background-shell',
  };
}

export function wrapToolForKernel(tool: AnyTool, deps: ToolWrapDeps): AnyTool {
  const originalExecute = tool.execute;
  const parameters = allowMkAgentMetadataProperties(tool.name === 'bash'
    ? {
        ...(tool.parameters as Record<string, unknown>),
        properties: {
          ...((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
          run_in_background: { type: 'boolean', description: 'Run as a background task with live output and a separate stop control.' },
        },
      } as AnyTool['parameters']
    : tool.parameters);

  const wrappedExecute: AnyTool['execute'] = async (args, api, context) => {
    const sdkToolName = PI_TOOL_NAME_MAP[tool.name] || tool.name;
    let inputObj: Record<string, unknown> = { ...(args as Record<string, unknown>) };

    // Extract intent before main process strips metadata (used for summarization)
    const intent = typeof inputObj._intent === 'string' ? inputObj._intent : undefined;

    const fileTool = tool.name === 'read' || tool.name === 'write' || tool.name === 'edit';
    if (fileTool && typeof inputObj.path === 'string') {
      const path = tool.name === 'read'
        ? resolveReadPath(inputObj.path, deps.shellEnv.cwd)
        : resolveToCwd(inputObj.path, deps.shellEnv.cwd);
      inputObj = { ...inputObj, path, file_path: path };
    }

    // Send to main process for permission checking + transforms
    const checkedPath = fileTool ? inputObj.path : undefined;
    inputObj = await deps.requestApproval(sdkToolName, inputObj, api.callId);
    if (fileTool && typeof inputObj.file_path === 'string') {
      const filePathChanged = inputObj.file_path !== checkedPath;
      const pathChanged = typeof inputObj.path === 'string' && inputObj.path !== checkedPath;
      if (filePathChanged && pathChanged && inputObj.file_path !== inputObj.path) {
        throw new Error('Conflicting approved file paths');
      }
      if (filePathChanged || !pathChanged) inputObj = { ...inputObj, path: inputObj.file_path };
    }

    // Metadata is for MkAgent UI only. Keep a final defensive strip here so the
    // upstream tool implementation always receives clean executable args,
    // even if a future pre-tool-use path returns `allow` without modification.
    inputObj = stripMkAgentMetadata(inputObj);

    if (tool.name === 'bash' && inputObj.run_in_background === true) {
      const { run_in_background: _background, ...bashArgs } = inputObj;
      const command = String(bashArgs.command ?? '');
      const timeout = typeof bashArgs.timeout === 'number' ? bashArgs.timeout : undefined;
      let outputBuffer = '';
      const started = deps.backgroundShells.start({
        directory: deps.tasksDirectory,
        toolUseId: api.callId,
        command,
        execute: async (taskSignal, update) => {
          const result = await deps.shellEnv.exec(command, {
            ...(timeout === undefined ? {} : { timeout }),
            onOutput: (text, _context, info) => {
              outputBuffer += text;
              update({ content: [{ type: 'text', text: outputBuffer }], details: undefined });
            },
          }, backgroundContext(taskSignal));
          // onOutput carries every raw chunk, so the buffer is the full output.
          const text = result.ok
            ? outputBuffer
            : (outputBuffer ? `${outputBuffer}\n${result.error.message}` : result.error.message);
          return {
            content: [{ type: 'text', text }],
            details: undefined,
            ...(!result.ok || result.value.exitCode !== 0 ? { isError: true } : {}),
          };
        },
      });
      // BackgroundShells speaks the old AgentToolResult shape. The result must
      // still satisfy durable's bash structuredOutput schema or the harness
      // reports an extension_error against the call; the task is still
      // running at this point, so exitCode is only a placeholder.
      const structured = {
        output: started.content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
        truncated: false,
        exitCode: 0,
      };
      return {
        output: started.content,
        structuredOutput: structured,
        ...((started as { isError?: boolean }).isError ? { isError: true } : {}),
      } as ToolExecutionResult;
    }

    // Execute original tool with (potentially modified) input
    const result = await originalExecute(inputObj, api, context);

    // --- Post-execute: large response summarization ---

    const output = (result as { output?: unknown }).output;
    const resultText = Array.isArray(output)
      ? output
        .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
        .map(c => c.text)
        .join('')
      : api.retainedOutput().text;

    // Source the active model's contextWindow each call so the threshold
    // tracks set_model mid-session, not the model that was active at session
    // creation. Falls back to the fixed default when the model isn't set yet.
    const modelContextWindow = deps.getContextWindow();
    const sessionPath = deps.getSessionPath();
    if (sessionPath && estimateTokens(resultText) > tokenLimitFor(modelContextWindow)) {
      try {
        const largeResult = await handleLargeResponse({
          text: resultText,
          sessionPath,
          context: {
            toolName: sdkToolName,
            input: inputObj,
            intent,
            userRequest: deps.getUserRequest(),
          },
          summarize: deps.summarize,
          contextWindow: modelContextWindow,
        });

        if (largeResult) {
          return {
            ...result,
            output: [{ type: 'text', text: largeResult.message }],
          } as ToolExecutionResult;
        }
      } catch (error) {
        deps.debugLog(
          `Large response handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return result;
  };

  return {
    ...tool,
    parameters,
    execute: wrappedExecute,
  };
}

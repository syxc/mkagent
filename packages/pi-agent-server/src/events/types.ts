/** Host event vocabulary retained across the durable 1.5 observer API change. */
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai';
import type { CompactionReason, EntryRecord, JsonObject, NestedToolExecutionResult, SubmissionId, SubmissionRecord, TaskId } from '@earendil-works/pi-durable';

export type MessageChange = {
  type: 'text_delta' | 'thinking_delta';
  contentIndex: number;
  delta: string;
};

interface ToolCall {
  toolCallId: string;
  toolName: string;
  taskId?: TaskId;
  parentToolCallId?: string;
  parentTaskId?: TaskId;
}

export type AgentEvent =
  | { type: 'snapshot' | 'inbox_update' | 'deferred_poll' | 'agent_changed' | 'usage_changed' | 'task_failed' }
  | { type: 'run_start' | 'run_end'; inputs: readonly SubmissionId[] }
  | { type: 'turn_start' | 'turn_end' }
  | { type: 'message_start'; message: Message }
  | { type: 'message_update'; message: AssistantMessage; usage: Usage; changes: readonly MessageChange[] }
  | { type: 'message_end' | 'entry_appended'; entry: EntryRecord }
  | ({ type: 'tool_execution_start'; args: JsonObject } & ToolCall)
  | ({ type: 'tool_execution_update'; output?: { set: string } | { trimStart?: number; append?: string } } & ToolCall)
  | ({ type: 'tool_execution_end'; entry?: EntryRecord; result?: NestedToolExecutionResult } & ToolCall)
  | { type: 'submission'; record: SubmissionRecord }
  | { type: 'auto_retry_start'; attempt: number; at: number; errorMessage: string }
  | { type: 'auto_retry_end'; attempt: number }
  | { type: 'compaction_start'; taskId: TaskId; reason: CompactionReason; blocking: boolean }
  | { type: 'compaction_end'; taskId: TaskId; reason: CompactionReason; error?: string };

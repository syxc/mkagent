/** Keep host correlation fields out of model context; SDK owns message conversion. */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { convertToLlm as convertSDKToLlm } from '@earendil-works/pi-coding-agent';

export {
  COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText, createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage,
  type BashExecutionMessage, type CustomMessage, type BranchSummaryMessage, type CompactionSummaryMessage,
} from '@earendil-works/pi-coding-agent';

export function convertToLlm(messages: AgentMessage[], options: { preserveHostMetadata?: boolean } = {}): Message[] {
  const converted = convertSDKToLlm(messages);
  if (options.preserveHostMetadata) return converted;
  return converted.map(message => {
    if (!('hostMessageId' in message || 'hostUserInput' in message)) return message;
    const clean = { ...message };
    Reflect.deleteProperty(clean, 'hostMessageId');
    Reflect.deleteProperty(clean, 'hostUserInput');
    return clean;
  });
}

/** Give host-admitted native inputs their durable product identity before append. */
import { randomUUID } from 'node:crypto';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { PromptOptions, SessionManager } from '@mkagent/coding-runtime/native';

export function captureNativeUserInput(content: UserMessage['content']): Pick<PromptOptions, 'hostMessageId' | 'hostUserInput'> {
  return {
    hostMessageId: `native-user-${randomUUID()}`,
    hostUserInput: { version: 1, content: structuredClone(content) },
  };
}

/** Bootstrap writes use the same capture path as sendUserMessage without starting a turn. */
export function setupSessionManager(manager: SessionManager): SessionManager {
  return new Proxy(manager, {
    get(target, key) {
      if (key === 'appendMessage') {
        return (message: Parameters<SessionManager['appendMessage']>[0]) => target.appendMessage(
          message.role === 'user' ? { ...message, ...captureNativeUserInput(message.content) } : message,
        );
      }
      const member = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** Pi plugin import identifiers resolve to this port and independent official packages. */
import * as coding from './compat.ts';
import * as ai from './upstream/core/extensions/pi-ai-extension-view.ts';
import * as models from '@earendil-works/pi-ai/models';
import * as oauth from '@earendil-works/pi-ai/oauth';
import * as providers from '@earendil-works/pi-ai/providers/all';
import * as tui from '@earendil-works/pi-tui';
import * as typebox from 'typebox';
import * as compile from 'typebox/compile';
import * as value from 'typebox/value';

function unavailableCore(): never {
  throw new Error('This host runs pi-durable. The pi-agent-core Agent/agentLoop runtime is unavailable.');
}

const core = { Agent: unavailableCore, agentLoop: unavailableCore, agentLoopContinue: unavailableCore };

export function getExtensionModules(): Record<string, unknown> {
  const modules: Record<string, unknown> = {
    typebox, 'typebox/compile': compile, 'typebox/value': value,
    '@sinclair/typebox': typebox, '@sinclair/typebox/compile': compile, '@sinclair/typebox/value': value,
  };
  for (const namespace of ['@earendil-works', '@mariozechner']) {
    Object.assign(modules, {
      [`${namespace}/pi-coding-agent`]: coding,
      [`${namespace}/pi-agent-core`]: core,
      [`${namespace}/pi-ai`]: ai,
      [`${namespace}/pi-ai/compat`]: ai,
      [`${namespace}/pi-ai/models`]: models,
      [`${namespace}/pi-ai/oauth`]: oauth,
      [`${namespace}/pi-ai/providers/all`]: providers,
      [`${namespace}/pi-tui`]: tui,
    });
  }
  return new Proxy(modules, {
    has(target, name) {
      if (typeof name === 'string' && !Reflect.has(target, name)
        && /^@(earendil-works|mariozechner)\/pi-(coding-agent|agent-core)\//.test(name)) {
        throw new Error(`Unsupported legacy runtime subpath: ${name}`);
      }
      return Reflect.has(target, name);
    },
  });
}

/** Explicit native provider authentication through the owning model runtime and RPC UI. */
import type { AuthEvent, AuthPrompt, AuthType, LoginOptions, Models } from '@earendil-works/pi-ai';
import { ModelRuntime, type ExtensionCommandContext, type ExtensionFactory } from '@mkagent/coding-runtime/native';

interface Operation {
  controller: AbortController;
  done: Promise<void>;
}

export interface ProviderAuthorizationOptions {
  models(): Models;
  assertOwner(): void;
  inputSecret(title: string, placeholder: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  loginOptions?: LoginOptions;
  changed?(provider: string, action: 'login' | 'logout', signal: AbortSignal): Promise<void>;
}

export class ProviderAuthorization {
  private readonly pending = new Set<Operation>();
  private readonly providers = new Map<string, Operation>();

  constructor(private readonly options: ProviderAuthorizationOptions) {}

  extension(): ExtensionFactory {
    return pi => {
      for (const action of ['login', 'logout'] as const) pi.registerCommand(action, {
        description: action === 'login' ? 'Sign in to a model provider' : 'Sign out of a model provider',
        handler: (args, ctx) => this.command(action, args, ctx),
      });
    };
  }

  async cancelAll(): Promise<void> {
    const pending = [...this.pending];
    for (const operation of pending) operation.controller.abort();
    await Promise.allSettled(pending.map(operation => operation.done));
  }

  private async command(action: 'login' | 'logout', args: string, ctx: ExtensionCommandContext): Promise<void> {
    const controller = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    const operation: Operation = {
      controller, done: Promise.resolve().then(() => this.run(action, args, ctx, operation, signal)),
    };
    this.pending.add(operation);
    try { await operation.done; }
    catch {
      // Provider errors can contain credentials. Only report the operation state to the UI.
      ctx.ui.notify(signal.aborted ? 'Provider operation cancelled.'
        : 'Provider authentication did not finish. Credentials may have changed; retry or sign out.',
      signal.aborted ? 'info' : 'error');
    } finally {
      this.pending.delete(operation);
      for (const [provider, current] of this.providers) if (current === operation) this.providers.delete(provider);
    }
  }

  private async run(action: 'login' | 'logout', args: string, ctx: ExtensionCommandContext,
    operation: Operation, signal: AbortSignal): Promise<void> {
    const check = () => { this.options.assertOwner(); signal.throwIfAborted(); };
    check();
    const models = this.options.models();
    const candidates = models.getProviders().filter(provider => action === 'logout'
      || provider.auth.oauth || provider.auth.apiKey?.login);
    let id = args.trim();
    if (!id) {
      if (!ctx.hasUI) throw new Error('Provider selection requires UI');
      id = await ctx.ui.select(`Provider ${action}`, candidates.map(provider => provider.id), { signal }) ?? '';
      if (!id) { operation.controller.abort(); check(); }
    }
    check();
    const provider = candidates.find(provider => provider.id === id);
    if (!provider || models !== this.options.models()) throw new Error('Provider is unavailable');
    const current = this.providers.get(id);
    if (current) {
      if (action !== 'logout') throw new Error('Provider authentication is already running');
      current.controller.abort();
      await current.done.catch(() => undefined);
      check();
    }
    this.providers.set(id, operation);
    const runtime = models instanceof ModelRuntime ? models : undefined;
    const registeredConfig = runtime?.getRegisteredProviderConfig(id);
    const registeredNative = runtime?.getRegisteredNativeProvider(id);
    let authenticated = false;
    const active = () => {
      check();
      const currentProvider = models.getProvider(id);
      // Native credential synchronization recomposes providers. Registration declarations
      // remain stable through that step and change when a plugin replaces its provider.
      const replaced = registeredConfig || registeredNative
        ? runtime?.getRegisteredProviderConfig(id) !== registeredConfig
          || runtime?.getRegisteredNativeProvider(id) !== registeredNative
        : (!authenticated || !runtime) && currentProvider !== provider;
      if (models !== this.options.models() || !currentProvider || replaced) {
        operation.controller.abort();
        signal.throwIfAborted();
      }
    };
    const widget = `provider-login-${id}`;
    try {
      active();
      if (action === 'logout') await models.logout(id, { signal });
      else {
        if (!ctx.hasUI) throw new Error('Provider sign-in requires UI');
        const methods: AuthType[] = [
          ...(provider.auth.oauth ? ['oauth' as const] : []),
          ...(provider.auth.apiKey?.login ? ['api_key' as const] : []),
        ];
        let method = methods[0]!;
        if (methods.length > 1) {
          const selected = await ctx.ui.select(`Sign in: ${id}`, ['OAuth', 'API key'], { signal });
          if (!selected) { operation.controller.abort(); check(); }
          method = selected === 'OAuth' ? 'oauth' : 'api_key';
        }
        active();
        await models.login(id, method, {
          signal,
          prompt: prompt => this.prompt(prompt, ctx, operation, signal, active),
          notify: event => { active(); ctx.ui.setWidget(widget, this.lines(event)); },
        }, this.options.loginOptions);
      }
      authenticated = true;
      active();
      ctx.ui.notify(`${action === 'login' ? 'Signed in to' : 'Signed out of'} provider "${id}".`, 'info');
      try { await this.options.changed?.(id, action, signal); }
      catch {
        active();
        ctx.ui.notify('Provider credentials changed, but an MCP connection needs a manual reconnect.', 'warning');
      }
      active();
    } finally { ctx.ui.setWidget(widget, undefined); }
  }

  private async prompt(prompt: AuthPrompt, ctx: ExtensionCommandContext,
    operation: Operation, signal: AbortSignal, check: () => void): Promise<string> {
    check();
    const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
    let value: string | undefined;
    if (prompt.type === 'select') {
      const labels = prompt.options.map((option, index) =>
        `${index + 1}. ${option.label}${option.description ? `: ${option.description}` : ''}`);
      const selected = await ctx.ui.select(prompt.message, labels, { signal: promptSignal });
      value = prompt.options[labels.indexOf(selected ?? '')]?.id;
    } else if (prompt.type === 'secret') {
      value = await this.options.inputSecret(prompt.message, prompt.placeholder, promptSignal);
    } else {
      value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal: promptSignal });
    }
    // A callback can cancel only its manual-code prompt while the login itself succeeds.
    promptSignal.throwIfAborted();
    if (value === undefined) operation.controller.abort();
    check();
    return value!;
  }

  private lines(event: AuthEvent): string[] {
    if (event.type === 'auth_url') return [...(event.instructions ? [event.instructions] : []), event.url];
    if (event.type === 'device_code') return [event.userCode, event.verificationUri];
    if (event.type === 'info') return [event.message, ...(event.links ?? []).flatMap(link =>
      [...(link.label ? [link.label] : []), link.url])];
    return [event.message];
  }
}

/** Keep cache writes inside host actions without replacing SDK scheduling or economics. */
export function codingCachePolicy(source: string, declaration: boolean): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published cache warming boundary changed: ' + before);
    source = source.replace(before, after);
  };
  if (declaration) {
    edit('    private readonly getMode;', '    private readonly getMode;\n    private readonly runAction;');
    edit('decide?: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>);',
      'decide?: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>, runAction?: <T>(work: () => Promise<T>) => Promise<T>);');
    edit('    private refresh;', '    private refresh;\n    private refreshInAction;');
    return source;
  }
  edit('    getMode;', '    getMode;\n    runAction;');
  edit('decide = async (event) => event.action) {', 'decide = async (event) => event.action, runAction) {');
  edit('        this.getMode = getMode;', '        this.getMode = getMode;\n        this.runAction = runAction;');
  edit('    async refresh(run) {', `    async refresh(run) {
        let entry;
        if (this.runAction) {
            try {
                entry = await this.runAction(() => this.refreshInAction(run));
            }
            catch {
                if (this.run === run) this.stop("cache usage persistence failed");
                return;
            }
        }
        else {
            entry = await this.refreshInAction(run);
        }
        try { if (entry) this.onWarmed?.(entry); } catch { /* Observers do not own warming. */ }
        if (this.run === run) this.schedule(run);
    }
    async refreshInAction(run) {`);
  edit('        run.extensionOverride = extensionOverride;\n        try {',
    '        run.extensionOverride = extensionOverride;\n        let message;\n        try {');
  edit('            const message = await this.models', '            message = await this.models');
  edit(`            if (!this.validateRun(run))
                return;
            if (message.stopReason !== "error" && message.stopReason !== "aborted") {
                const entry = this.sessionManager.appendUsage("cache_warm", message.provider, message.responseModel ?? message.model, message.usage, extensionOverride ? "extension override" : undefined);
                this.onWarmed?.(entry);
            }
        }
        catch {
            // Cache warming is best-effort and must not affect the active agent run.
        }
        if (this.run === run)
            this.schedule(run);`, `        }
        catch {
            // Network failures remain best-effort inside or outside a host action.
            return;
        }
        if (!this.validateRun(run) || message.stopReason === "error" || message.stopReason === "aborted") return;
        try {
            return this.sessionManager.appendUsage("cache_warm", message.provider, message.responseModel ?? message.model, message.usage, extensionOverride ? "extension override" : undefined);
        }
        catch (error) {
            // A host must see persistence errors; the default SDK path stays best-effort.
            if (this.runAction) throw error;
        }`);
  return source;
}

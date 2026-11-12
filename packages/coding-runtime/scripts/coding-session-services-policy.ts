/** Expose SDK model initialization and let hosts supply their session constructor. */
export function codingSessionServicesPolicy(source: string, declaration: boolean): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published session services boundary changed: ' + before);
    source = source.replace(before, after);
  };
  const marker = '//# sourceMappingURL=';
  if (declaration) {
    edit('export declare function createAgentSessionFromServices(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult>;',
      'export declare function createAgentSessionFromServices(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult>;\n'
      + 'export declare function createAgentSessionFromServices<Result extends CreateAgentSessionResult>(options: CreateAgentSessionFromServicesOptions, createSession: (options: CreateAgentSessionOptions) => Promise<Result>): Promise<Result>;');
    edit(marker, 'export declare function initializeExtensionModels(resourceLoader: ResourceLoader, modelRuntime: ModelRuntime): Promise<AgentSessionRuntimeDiagnostic[]>;\n' + marker);
    return source;
  }
  edit('export async function createAgentSessionFromServices(options) {\n    return createAgentSession({',
    'export async function createAgentSessionFromServices(options, createSession = createAgentSession) {\n    return createSession({');
  const startMarker = '    const diagnostics = [];\n    const extensionsResult = resourceLoader.getExtensions();\n    for (const { name, config, extensionPath }';
  const endMarker = '    await modelRuntime.refresh({ allowNetwork: false });';
  if (source.split(startMarker).length !== 2 || source.split(endMarker).length !== 2) {
    throw new Error('Published extension model initialization changed');
  }
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start) + endMarker.length;
  const implementation = source.slice(start, end);
  source = source.slice(0, start) + '    const diagnostics = await initializeExtensionModels(resourceLoader, modelRuntime);' + source.slice(end);
  edit(marker, 'export async function initializeExtensionModels(resourceLoader, modelRuntime) {\n' + implementation + '\n    return diagnostics;\n}\n' + marker);
  return source;
}

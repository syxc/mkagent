/** Preserve host session subtypes without changing the published runtime algorithm. */
export function codingSessionRuntimePolicy(source: string): string {
  const edit = (before: string, after: string, count = 1) => {
    if (source.split(before).length !== count + 1) throw new Error('Published session runtime declaration changed: ' + before);
    source = source.replaceAll(before, after);
  };
  edit('export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {',
    'export interface CreateAgentSessionRuntimeResult<Session extends AgentSession = AgentSession> extends CreateAgentSessionResult {\n    session: Session;');
  edit('export type CreateAgentSessionRuntimeFactory = (options:',
    'export type CreateAgentSessionRuntimeFactory<Session extends AgentSession = AgentSession> = (options:');
  edit('}) => Promise<CreateAgentSessionRuntimeResult>;', '}) => Promise<CreateAgentSessionRuntimeResult<Session>>;');
  edit('export declare class AgentSessionRuntime {', 'export declare class AgentSessionRuntime<Session extends AgentSession = AgentSession> {');
  edit('_session: AgentSession,', '_session: Session,');
  edit('createRuntime: CreateAgentSessionRuntimeFactory,', 'createRuntime: CreateAgentSessionRuntimeFactory<Session>,', 2);
  edit('get session(): AgentSession;', 'get session(): Session;');
  edit('setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;',
    'setRebindSession(rebindSession?: (session: Session) => Promise<void>): void;');
  edit('export declare function createAgentSessionRuntime(',
    'export declare function createAgentSessionRuntime<Session extends AgentSession = AgentSession>(');
  edit('}): Promise<AgentSessionRuntime>;', '}): Promise<AgentSessionRuntime<Session>>;');
  return source;
}

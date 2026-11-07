/** Reuse core state and lifecycle operations without entering its scheduling loop. */
import ts from 'typescript';

export function portAgentFacade(source: string): string {
  const ast = ts.createSourceFile('agent.ts', source, ts.ScriptTarget.Latest, true);
  const policies = ast.statements.filter(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'defaultConvertToLlm' ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && ['EMPTY_USAGE', 'DEFAULT_MODEL'].includes(declaration.name.text)));
  if (policies.length !== 3) throw new Error('Pinned native Agent defaults changed');
  return `import { Agent as CoreAgent, type AgentOptions as CoreAgentOptions } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { DurableLoopBinding } from "./durable-coding/engine.ts";
import { runAgentLoop, runAgentLoopContinue } from "./durable-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type { AgentMessage, AgentLoopConfig } from "./agent-runtime.ts";
export type { AgentInitialState, QueueMode } from "@earendil-works/pi-agent-core";
export interface AgentOptions extends CoreAgentOptions { durable?: DurableLoopBinding; }

// Keep Native defaults separate from the mutable public core defaults.
${policies.map(node => node.getText(ast)).join('\n\n')}

export class Agent extends CoreAgent {
  declare readonly durable: DurableLoopBinding;

  constructor(options: AgentOptions) {
    const runtimeOptions: Partial<AgentOptions> = options ?? {};
    super(options, {
      run: runAgentLoop, continue: runAgentLoopContinue,
      defaultModel: DEFAULT_MODEL, defaultUsage: EMPTY_USAGE,
      defaultConvertToLlm, getDefaultStreamFn,
      initialize(agent, restoreMessages) {
        const durable = runtimeOptions.durable ?? new DurableLoopBinding();
        Object.defineProperty(agent, "durable", {
          value: durable, enumerable: true, configurable: true, writable: true,
        });
        durable.setMessageRestorer(restoreMessages);
      },
    });
  }

  override steer(message: AgentMessage): void {
    this.durable.identifyQueuedMessage(message);
    this.steeringQueue.enqueue(message);
  }

  override followUp(message: AgentMessage): void {
    this.durable.identifyQueuedMessage(message);
    this.followUpQueue.enqueue(message);
  }

  override clearSteeringQueue(): void {
    this.durable.discardQueuedInputs(this.steeringQueue.snapshot());
    this.steeringQueue.clear();
  }

  override clearFollowUpQueue(): void {
    this.durable.discardQueuedInputs(this.followUpQueue.snapshot());
    this.followUpQueue.clear();
  }

  /** Snapshot all inputs independently of the next-turn drain modes. */
  exportDurableQueues() {
    return {
      steering: this.steeringQueue.snapshot(), followUp: this.followUpQueue.snapshot(),
      steeringMode: this.steeringMode, followUpMode: this.followUpMode,
    };
  }

  restoreDurableQueues(state: ReturnType<Agent["exportDurableQueues"]>): void {
    this.steeringQueue.clear();
    this.followUpQueue.clear();
    this.steeringMode = state.steeringMode;
    this.followUpMode = state.followUpMode;
    for (const message of state.steering) this.steer(message);
    for (const message of state.followUp) this.followUp(message);
  }

  /** Rebind resources and listeners before resuming a persisted durable run. */
  async resumeDurable(onBound?: () => void, taskId?: TaskId): Promise<boolean> {
    if (this.activeRun) throw new Error("Agent is already processing.");
    if (taskId === undefined && await this.durable.pendingRun() === undefined) return false;
    await this.runWithLifecycle(signal => this.durable.recover(
      this.createContextSnapshot(), this.createLoopConfig(), event => this.processEvents(event),
      signal, this.streamFunction, onBound, taskId,
    ));
    return true;
  }

  protected override createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    const durable = this.durable;
    return { durable, ...super.createLoopConfig(options) };
  }
}
`;
}

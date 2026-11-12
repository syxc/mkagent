import { RpcClient as SDKRpcClient } from '@earendil-works/pi-coding-agent';

export type {
  JsonAgentSessionEvent, ModelInfo, RpcClientOptions, RpcCommand, RpcEventListener,
  RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse, RpcSessionState,
} from '@earendil-works/pi-coding-agent';

/** Keep CLI ownership with the caller while the SDK owns the client lifecycle and JSONL. */
export class RpcClient extends SDKRpcClient {
  protected override resolveCliPath(cliPath: string | undefined): string {
    if (!cliPath) {
      throw new Error('RpcClient requires options.cliPath; this package does not include a CLI launcher.');
    }
    return cliPath;
  }
}

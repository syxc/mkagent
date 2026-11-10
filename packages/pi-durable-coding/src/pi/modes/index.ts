/**
 * RPC client and protocol exports.
 */

export type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";

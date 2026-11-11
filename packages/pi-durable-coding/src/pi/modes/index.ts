/**
 * RPC client and protocol exports.
 */

export type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "../../compat/rpc-client.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";

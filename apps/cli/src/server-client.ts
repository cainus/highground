import type { contract } from "@highground/core";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

export type ServerClient = ContractRouterClient<typeof contract>;

/** A typed client for a Highground server's RPC endpoint. */
export function serverClient(url: string): ServerClient {
  return createORPCClient(new RPCLink({ url: `${url.replace(/\/+$/, "")}/rpc` }));
}

/** A one-line reason for a failure, including a network error's cause. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

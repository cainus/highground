import type { contract } from "@highground/core";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

export type ServerClient = ContractRouterClient<typeof contract>;

/** Where a client gets the user's token; see `Credentials`. */
export interface TokenSource {
  token(): Promise<string | undefined>;
}

/**
 * A typed client for a Highground server's RPC endpoint. With `credentials`, each request
 * carries the user's current token, so a refresh takes effect without a new client.
 */
export function serverClient(url: string, credentials?: TokenSource): ServerClient {
  return createORPCClient(
    new RPCLink({
      url: `${url.replace(/\/+$/, "")}/rpc`,
      headers: async (): Promise<Record<string, string>> => {
        const token = await credentials?.token();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  );
}

/** A one-line reason for a failure, including a network error's cause. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

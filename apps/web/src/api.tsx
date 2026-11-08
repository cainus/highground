import type { contract } from "@highground/core";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createContext, useContext } from "react";

export type ApiClient = ContractRouterClient<typeof contract>;
export type Api = {
  client: ApiClient;
  orpc: ReturnType<typeof createTanstackQueryUtils<ApiClient>>;
};

/**
 * The browser's client for this origin's server. Every call carries a fresh request id,
 * so a failure the dashboard logs can be found in the server's log too.
 */
export function browserClient(): ApiClient {
  return createORPCClient(
    new RPCLink({
      url: new URL("/rpc", window.location.origin).toString(),
      headers: () => ({ "x-request-id": crypto.randomUUID() }),
      fetch: (request, init) => fetch(request, { ...init, credentials: "same-origin" }),
    }),
  );
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside <App>");
  return api;
}

/** The error's oRPC code, for telling "sign in" from "not here" from "broken". */
export const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

import type { Me } from "@highground/core";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { LogIn, LogOut } from "lucide-react";
import { Component, useMemo, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useParams } from "react-router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { ApiContext, codeOf, useApi, type ApiClient } from "./api.tsx";
import { Button } from "./components/ui/button.tsx";
import { NotifyButton } from "./components/notify-button.tsx";
import { logError } from "./log.ts";
import { cn } from "./lib/utils.ts";
import { AdminPage } from "./pages/admin.tsx";
import { HistoryPage } from "./pages/history.tsx";
import { RadarPage } from "./pages/radar.tsx";

export interface AppProps {
  client: ApiClient;
  /** Retry failed queries; tests turn it off. */
  retry?: boolean;
}

/** The dashboard (PRD §10): sign-in, then Radar, My work, History and Admin. */
export function App({ client, retry = true }: AppProps) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: retry ? 2 : false } } }),
  );
  const api = useMemo(() => ({ client, orpc: createTanstackQueryUtils(client) }), [client]);
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>
        <ErrorBoundary>
          <Shell />
        </ErrorBoundary>
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    logError(error, "render failed");
  }
  override render() {
    return this.state.failed ? (
      <main className="mx-auto max-w-xl p-8 text-secondary">
        Something broke. It has been logged; reload to try again.
      </main>
    ) : (
      this.props.children
    );
  }
}

/** Who is looking: a user, `null` on an instance without sign-in, or not yet signed in. */
function useMe() {
  const { orpc } = useApi();
  const me = useQuery({ ...orpc.me.queryOptions(), retry: false, staleTime: 5 * 60_000 });
  const code = codeOf(me.error);
  return {
    loading: me.isPending,
    me: code === "NOT_FOUND" ? null : (me.data ?? null),
    signedOut: code === "UNAUTHORIZED",
  };
}

function Shell() {
  const { loading, me, signedOut } = useMe();
  const location = useLocation();
  if (loading) return <main className="p-8 text-muted">Loading…</main>;
  if (signedOut) return <SignIn next={`${location.pathname}${location.search}`} />;
  return (
    <div className="min-h-screen">
      <Header me={me} />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/radar/*" element={<RadarPage me={me} mine={false} />} />
          <Route path="/mine/*" element={<RadarPage me={me} mine />} />
          <Route path="/history/*" element={<HistoryPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function SignIn({ next }: { next: string }) {
  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border border-border bg-surface-1 p-8 text-center">
      <h1 className="text-xl font-semibold">Highground</h1>
      <p className="mt-2 text-sm text-secondary">
        See who else is changing the code you are, before it becomes a merge conflict.
      </p>
      <Button asChild className="mt-6 w-full">
        <a href={`/auth/login?next=${encodeURIComponent(next)}`}>
          <LogIn aria-hidden className="size-4" />
          Sign in with GitHub
        </a>
      </Button>
    </main>
  );
}

/** The repository in the current URL, if the page is about one. */
function useRepo(): string | undefined {
  const { "*": rest } = useParams();
  const location = useLocation();
  const match = /^\/(?:radar|mine|history)\/(.+)$/.exec(location.pathname);
  return rest || match?.[1] || undefined;
}

function Header({ me }: { me: Me | null }) {
  const { orpc } = useApi();
  const repos = useQuery(orpc.repos.queryOptions());
  const current = useRepo() ?? repos.data?.repos[0];
  const tab = (to: string, label: string) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "rounded-md px-3 py-1.5 text-sm",
          isActive ? "bg-surface-2 font-medium text-primary" : "text-secondary hover:text-primary",
        )
      }
    >
      {label}
    </NavLink>
  );
  return (
    <header className="border-b border-border bg-surface-1">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
        <img src="/icon.svg" alt="" className="size-6" />
        <span className="mr-4 font-semibold">Highground</span>
        <nav className="flex flex-wrap gap-1" aria-label="Pages">
          {current && tab(`/radar/${current}`, "Radar")}
          {current && me && tab(`/mine/${current}`, "My work")}
          {current && tab(`/history/${current}`, "History")}
          {tab("/admin", "Admin")}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {me && <NotifyButton />}
          {me && (
            <>
              <img src={me.avatar_url} alt="" className="size-7 rounded-full" />
              <span className="text-sm text-secondary">{me.login}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Sign out"
                onClick={() =>
                  void fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).then(
                    () => window.location.assign("/"),
                  )
                }
              >
                <LogOut aria-hidden className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function Home() {
  const { orpc } = useApi();
  const repos = useQuery(orpc.repos.queryOptions());
  if (repos.isPending) return <p className="text-muted">Loading…</p>;
  const first = repos.data?.repos[0];
  if (first) return <Navigate to={`/radar/${first}`} replace />;
  return (
    <p className="text-secondary">
      No repositories yet. Run <code className="font-mono">highground daemon</code> in a working
      copy and it appears here.
    </p>
  );
}

export { useRepo };

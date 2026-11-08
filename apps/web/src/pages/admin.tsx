import type { Admin } from "@highground/core";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { useApi } from "../api.tsx";
import { Card } from "../components/ui/card.tsx";
import { sinceIso } from "../lib/utils.ts";

/** A status with its icon and label, never colour alone. */
function Status({ tone, label }: { tone: "good" | "serious" | "critical"; label: string }) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "serious" ? CircleAlert : XCircle;
  const color = { good: "text-good", serious: "text-serious", critical: "text-critical" }[tone];
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <Icon aria-hidden className={`size-4 ${color}`} />
      {label}
    </span>
  );
}

const INSTALLATION = {
  ok: { tone: "good", label: "App installed" },
  missing: { tone: "critical", label: "App not installed" },
  error: { tone: "serious", label: "App check failed" },
} as const;

/** Admin (PRD §10): mirror health, the GitHub App, and clients reporting trouble. */
export function AdminPage() {
  const { orpc } = useApi();
  const admin = useQuery({ ...orpc.admin.queryOptions(), refetchInterval: 30_000 });
  if (admin.isPending) return <p className="text-muted">Loading…</p>;
  if (admin.isError) return <p role="alert">Admin is unavailable: {admin.error.message}</p>;
  return <AdminView admin={admin.data} />;
}

function AdminView({ admin }: { admin: Admin }) {
  return (
    <section className="grid gap-4">
      <h1 className="text-lg font-semibold">Admin</h1>
      {!admin.github.configured && (
        <p className="text-sm text-secondary">
          This instance has no GitHub App: no mirror, pushed work, or sign-in.
        </p>
      )}
      <Card className="overflow-x-auto p-4">
        <h2 className="font-semibold">Repositories</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-normal">Repository</th>
              <th className="py-1 font-normal">Last fetch</th>
              <th className="py-1 font-normal">Mirror</th>
              <th className="py-1 font-normal">GitHub App</th>
            </tr>
          </thead>
          <tbody>
            {admin.repos.map((r) => (
              <tr key={r.repo} className="border-t border-border align-top">
                <td className="py-1.5 font-mono text-xs">{r.repo}</td>
                <td className="py-1.5 text-secondary">
                  {r.last_fetch_at ? sinceIso(r.last_fetch_at) : "never"}
                </td>
                <td className="py-1.5">
                  {r.last_error ? (
                    <div>
                      <Status tone="critical" label="Fetch failing" />
                      <div className="text-xs text-secondary">{r.last_error}</div>
                    </div>
                  ) : r.last_fetch_at ? (
                    <Status tone="good" label="Fetching" />
                  ) : (
                    <span className="text-secondary">not mirrored</span>
                  )}
                </td>
                <td className="py-1.5">
                  {r.installation ? <Status {...INSTALLATION[r.installation]} /> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="overflow-x-auto p-4">
        <h2 className="font-semibold">Clients reporting trouble (last hour)</h2>
        {admin.clients.length === 0 ? (
          <p className="mt-2 text-sm text-secondary">
            Every client that reported is working normally.
          </p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Client</th>
                <th className="py-1 font-normal">Repository</th>
                <th className="py-1 font-normal">Trouble</th>
                <th className="py-1 font-normal">Reported</th>
              </tr>
            </thead>
            <tbody>
              {admin.clients.map((c) => (
                <tr
                  key={`${c.working_copy_id}|${c.client}`}
                  className="border-t border-border align-top"
                >
                  <td className="py-1.5">
                    {c.client} {c.version}
                    {c.route && <div className="text-xs text-secondary">via {c.route}</div>}
                    <div className="font-mono text-[10px] text-muted">{c.working_copy_id}</div>
                  </td>
                  <td className="py-1.5 font-mono text-xs">{c.repo}</td>
                  <td className="py-1.5">{c.degraded}</td>
                  <td className="py-1.5 text-secondary">{sinceIso(c.reported_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

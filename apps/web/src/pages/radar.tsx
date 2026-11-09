import type { Me, Radar, RadarFile, Reporting } from "@highground/core";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api.tsx";
import { FileRadar } from "../components/file-radar.tsx";
import { ago } from "@/lib/utils";

/** The files that hold the viewer's own work, with everyone's work on them. */
function mineOnly(radar: Radar, me: Me | null): RadarFile[] {
  const emails = new Set(me?.emails ?? []);
  return radar.files.filter((file) => file.work.some((w) => emails.has(w.author)));
}

/** Every branch with work on the radar, with how many collisions it is in. */
function branchesOf(files: RadarFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const branchOf = new Map(file.work.map((w) => [w.id, w.branch]));
    for (const w of file.work) if (!counts.has(w.branch)) counts.set(w.branch, 0);
    for (const c of file.collisions) {
      for (const branch of new Set([branchOf.get(c.a), branchOf.get(c.b)])) {
        if (branch !== undefined) counts.set(branch, (counts.get(branch) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * One branch's collisions alone: the files it collides on, and on each only its own
 * work, the work it collides with, and those collisions.
 */
function forBranch(files: RadarFile[], branch: string): RadarFile[] {
  const result: RadarFile[] = [];
  for (const file of files) {
    const ours = new Set(file.work.filter((w) => w.branch === branch).map((w) => w.id));
    const collisions = file.collisions.filter((c) => ours.has(c.a) || ours.has(c.b));
    if (collisions.length === 0) continue;
    const shown = new Set(collisions.flatMap((c) => [c.a, c.b]));
    result.push({ ...file, collisions, work: file.work.filter((w) => shown.has(w.id)) });
  }
  return result;
}

/** What the chosen branch is for, as its working copy described it, above its collisions. */
function BranchSummary({ files, branch }: { files: RadarFile[]; branch: string }) {
  const summary = files
    .flatMap((f) => f.work)
    .find((w) => w.branch === branch && w.summary !== null)?.summary;
  return (
    <section aria-label={branch} className="mb-4 rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="font-mono text-sm font-semibold break-all">{branch}</h2>
      {summary ? (
        <p className="mt-1 text-sm whitespace-pre-line text-primary">{summary}</p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          {branch} hasn&apos;t said what it&apos;s for. An agent working there can say with{" "}
          <code className="font-mono">describe_work</code>, or write it in{" "}
          <code className="font-mono">.highground/summary.md</code>.
        </p>
      )}
    </section>
  );
}

const collisionCount = (n: number) =>
  n === 0 ? "no collisions" : n === 1 ? "1 collision" : `${n} collisions`;

/** Whether every word typed appears in a branch's name, in any case and order. */
const matches = (branch: string, query: string) => {
  const name = branch.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => name.includes(term));
};

/**
 * Chooses one branch to see alone, or all of them: a list in name order, so a branch
 * stays put while collisions come and go, narrowed by typing. A branch stays listed once
 * seen, marked as having no work, so it does not vanish from under the pointer.
 */
function BranchPicker({
  files,
  branch,
  onChange,
}: {
  files: RadarFile[];
  branch: string | null;
  onChange: (branch: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const seen = useRef(new Set<string>());
  const counts = branchesOf(files);
  for (const name of counts.keys()) seen.current.add(name);
  if (branch) seen.current.add(branch);
  const shown = [...seen.current]
    .filter((name) => matches(name, query.trim()))
    .sort((x, y) => x.localeCompare(y));
  const item = (name: string | null, label: string, detail?: string) => (
    <li key={name ?? ""}>
      <button
        type="button"
        aria-current={branch === name ? "true" : undefined}
        onClick={() => onChange(name)}
        className="w-full rounded-md px-2 py-1 text-left hover:bg-surface-2 aria-[current=true]:bg-surface-2 aria-[current=true]:font-semibold"
      >
        <span className="block font-mono text-sm break-all text-primary">{label}</span>
        {detail && <span className="block text-xs text-muted">{detail}</span>}
      </button>
    </li>
  );
  return (
    <nav
      aria-label="Branches"
      className="grid content-start gap-2 md:sticky md:top-4 md:max-h-[calc(100vh-2rem)]"
    >
      <input
        type="search"
        aria-label="Find a branch"
        placeholder="Find a branch"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && shown[0] !== undefined) {
            onChange(shown[0]);
            setQuery("");
          } else if (event.key === "Escape") {
            setQuery("");
          }
        }}
        className="rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-primary"
      />
      <ul className="max-h-60 overflow-y-auto md:max-h-none">
        {item(null, "All branches")}
        {shown.map((name) => {
          const n = counts.get(name);
          return item(name, name, n === undefined ? "no work now" : collisionCount(n));
        })}
      </ul>
      {shown.length === 0 && <p className="px-2 text-sm text-muted">No branch matches.</p>}
    </nav>
  );
}

/**
 * Why a radar is empty. With no daemon reporting, it cannot say no one is working, only
 * that it cannot see them, and since when.
 */
function Empty({ reporting, mine }: { reporting: Reporting; mine: boolean }) {
  if (reporting.working_copies === 0) {
    const last = reporting.last_heartbeat_at;
    return (
      <div className="grid gap-1">
        <p className="text-secondary">No daemon is reporting this repository.</p>
        <p className="text-sm text-muted">
          {last
            ? `Last heartbeat ${ago(Math.max(0, Math.floor((Date.now() - Date.parse(last)) / 1000)))}. `
            : "Nothing has reported here since the server started. "}
          Run <code className="font-mono">highground daemon</code> in a working copy to report it.
        </p>
      </div>
    );
  }
  const n = reporting.working_copies;
  return (
    <div className="grid gap-1">
      <p className="text-secondary">
        {mine
          ? "None of your work is in flight in this repository."
          : "No one is changing anything in this repository right now."}
      </p>
      <p className="text-sm text-muted">
        {n === 1 ? "1 working copy is reporting." : `${n} working copies are reporting.`}
      </p>
    </div>
  );
}

/** Radar (PRD §10), or My work: the same live view filtered to the viewer's own work. */
export function RadarPage({ me, mine }: { me: Me | null; mine: boolean }) {
  const { "*": repo = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const focus = params.get("path");
  const branch = params.get("branch");
  const chooseBranch = (next: string | null) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next) updated.set("branch", next);
      else updated.delete("branch");
      return updated;
    });
  const { orpc } = useApi();
  const radar = useQuery(orpc.watchRadar.experimental_liveOptions({ input: { repo } }));

  const scope = radar.data ? (mine ? mineOnly(radar.data, me) : radar.data.files) : [];
  const files = branch ? forBranch(scope, branch) : scope;
  useEffect(() => {
    if (!focus) return;
    document.getElementById(`file-${focus}`)?.scrollIntoView?.({ block: "center" });
  }, [focus, radar.data !== undefined]);

  return (
    <section>
      <h1 className="mb-4 flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
        {mine ? "My work" : "Radar"}
        <span className="font-mono text-sm font-normal text-secondary">{repo}</span>
      </h1>
      {radar.isPending && (
        <p role="status" aria-label="Loading the radar" className="flex justify-center py-12">
          <LoaderCircle aria-hidden className="size-6 text-muted motion-safe:animate-spin" />
        </p>
      )}
      {radar.isError && (
        <p className="text-secondary" role="alert">
          The radar is unavailable: {radar.error.message}
        </p>
      )}
      {radar.data && scope.length === 0 && !branch && (
        <Empty reporting={radar.data.reporting} mine={mine} />
      )}
      {radar.data && (scope.length > 0 || branch) && (
        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <BranchPicker
            key={`${repo}\0${mine}`}
            files={scope}
            branch={branch}
            onChange={chooseBranch}
          />
          <div className="grid content-start gap-4">
            {branch && <BranchSummary files={scope} branch={branch} />}
            {files.length === 0 && branch && (
              <p className="text-secondary">{branch} collides with no one right now.</p>
            )}
            {files.map((file) => (
              <FileRadar
                key={file.path}
                file={file}
                focused={file.path === focus}
                mine={new Set(me?.emails)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

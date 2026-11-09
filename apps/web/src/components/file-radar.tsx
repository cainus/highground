import type { RadarCollision, RadarFile, RadarWork } from "@highground/core";
import { ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { ago, cn } from "@/lib/utils";
import { Card } from "./ui/card.tsx";
import { Severity } from "./severity.tsx";

const KIND_COLOR: Record<RadarWork["kind"], string> = {
  live: "var(--kind-live)",
  parked: "var(--kind-parked)",
  pushed: "var(--kind-pushed)",
};

const RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

const TYPE_LABEL: Record<RadarCollision["type"], string> = {
  DIRECT_OVERLAP: "Same lines",
  DUPLICATE_CHANGE: "Same change twice",
  PROXIMITY_ALERT: "Nearby lines",
};

/**
 * The work's name: its branch, which is what tells efforts apart, then the agent doing
 * it, if one is. Who it belongs to is shown beside it, not in it.
 */
export function workName(work: RadarWork): string {
  return work.actor.type === "agent" ? `${work.branch} · ${work.actor.id}` : work.branch;
}

/**
 * A collision's two sides by name, adding each author only when the authors differ.
 * Hovering a side's name shows what its work is for, when it said.
 */
function PairName({ a, b }: { a: RadarWork; b: RadarWork }) {
  const side = (w: RadarWork) => {
    const named = w.summary ? (
      <span
        title={w.summary}
        className="cursor-help underline decoration-dotted underline-offset-4"
      >
        {workName(w)}
      </span>
    ) : (
      <span>{workName(w)}</span>
    );
    return a.author === b.author ? (
      named
    ) : (
      <>
        {w.author} · {named}
      </>
    );
  };
  return (
    <>
      {side(a)} ↔ {side(b)}
    </>
  );
}

type WholeFile = Exclude<RadarWork["whole_file"], false>;

/** What whole-file work does to the file, for a work row. */
const WHOLE_FILE_LABEL: Record<WholeFile, string> = {
  added: "new file",
  deleted: "deletes the file",
  binary: "binary file",
  renamed: "renamed to this path",
  whole: "whole file",
};

/** What whole-file work does to the file, for a collision. */
const WHOLE_FILE_VERB: Record<WholeFile, string> = {
  added: "creates this file",
  deleted: "deletes this file",
  binary: "changes this binary file",
  renamed: "renames a file to this path",
  whole: "changes the whole file",
};

const linesLabel = (work: RadarWork) =>
  work.whole_file
    ? WHOLE_FILE_LABEL[work.whole_file]
    : work.lines
        .map(([start, end]) =>
          end < start
            ? `after line ${end}`
            : start === end
              ? `line ${start}`
              : `lines ${start}–${end}`,
        )
        .join(", ");

/**
 * Why a pair collides. Whole-file work collides with everything on the file, so its
 * verdict is what that work does to the file, by whom, not which lines meet.
 */
function verdict(collision: RadarCollision, a?: RadarWork, b?: RadarWork): string {
  const whole = [a, b].filter((w): w is RadarWork & { whole_file: WholeFile } =>
    Boolean(w?.whole_file),
  );
  const parts: string[] =
    whole.length > 0
      ? whole.map((w) => `${workName(w)} ${WHOLE_FILE_VERB[w.whole_file]}`)
      : [TYPE_LABEL[collision.type]];
  if (collision.confirmed === true) parts.push("confirmed by merge");
  if (collision.confirmed === false) parts.push("merges cleanly");
  if (collision.approximate) parts.push("approximate");
  return parts.join(" · ");
}

/** One file's work as rows on a shared line axis, its collisions above. */
export function FileRadar({
  file,
  focused,
  mine,
}: {
  file: RadarFile;
  focused: boolean;
  mine: Set<string>;
}) {
  const byId = new Map(file.work.map((w) => [w.id, w]));
  const lastLine = Math.max(
    10,
    ...file.work.flatMap((w) => w.lines.map(([s, e]) => Math.max(s, e))),
  );
  const domain = Math.ceil(lastLine * 1.1);
  const headingId = useId();
  // Each work row is marked with the worst collision it is in.
  const colliding = new Map<string, RadarCollision["severity"]>();
  for (const c of file.collisions) {
    for (const id of [c.a, c.b]) {
      const held = colliding.get(id);
      if (!held || RANK[c.severity] > RANK[held]) colliding.set(id, c.severity);
    }
  }

  return (
    <Card
      id={`file-${file.path}`}
      role="article"
      aria-labelledby={headingId}
      aria-current={focused ? "true" : undefined}
      className={cn("p-4", focused && "outline-2 outline-offset-2 outline-accent")}
    >
      <h2 id={headingId} className="font-mono text-sm font-semibold break-all">
        {file.path}
      </h2>

      {file.collisions.length > 0 && (
        <ul className="mt-3 grid gap-1.5" aria-label="Collisions">
          {file.collisions.map((c) => {
            const a = byId.get(c.a);
            const b = byId.get(c.b);
            return (
              <li key={`${c.a}|${c.b}`} className="flex flex-wrap items-center gap-2 text-sm">
                <Severity level={c.severity} />
                <span className="font-medium text-primary">
                  {a && b ? <PairName a={a} b={b} /> : `${c.a} ↔ ${c.b}`}
                </span>
                <span className="text-secondary">{verdict(c, a, b)}</span>
              </li>
            );
          })}
        </ul>
      )}

      <ul className="mt-4 grid gap-3" aria-label="Work">
        {file.work.map((w) => (
          <WorkRow
            key={w.id}
            work={w}
            domain={domain}
            severity={colliding.get(w.id)}
            own={mine.has(w.author)}
          />
        ))}
      </ul>
      <Axis domain={domain} />
    </Card>
  );
}

function WorkRow({
  work,
  domain,
  severity,
  own,
}: {
  work: RadarWork;
  domain: number;
  severity: RadarCollision["severity"] | undefined;
  own: boolean;
}) {
  const [hover, setHover] = useState(false);
  const pct = (line: number) => `${(Math.max(0, line - 1) / domain) * 100}%`;
  return (
    <li className="grid gap-1 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-center sm:gap-4">
      <div className="min-w-0 text-sm">
        <div className={cn("truncate", own ? "font-semibold" : "font-medium")}>
          <span
            aria-hidden
            className="mr-1.5 inline-block size-2.5 rounded-sm align-middle"
            style={{ background: KIND_COLOR[work.kind] }}
          />
          {workName(work)}
        </div>
        {work.summary && (
          <p className="mt-0.5 line-clamp-2 text-xs text-primary" title={work.summary}>
            {work.summary}
          </p>
        )}
        <div className="flex flex-wrap gap-x-2 text-xs text-secondary">
          <span className="truncate">{work.author}</span>
          {work.kind !== "live" && <span>{work.kind}</span>}
          <span>{linesLabel(work)}</span>
          {work.approximate && <span title="Not yet translated into this file's base">≈</span>}
          <span>{ago(work.last_heartbeat_seconds_ago)}</span>
          {work.pr_url && (
            <a
              className="inline-flex items-center gap-0.5 text-accent underline"
              href={work.pr_url}
            >
              #{work.pr_url.split("/").pop()}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
        </div>
        {work.intent && <p className="mt-0.5 text-xs text-primary italic">{work.intent}</p>}
      </div>
      <div
        className="relative h-6 rounded bg-surface-2"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {(work.whole_file ? [[1, domain] as const] : work.lines).map(([start, end]) => (
          <div
            key={`${start}-${end}`}
            className={cn(
              "bar absolute top-1 bottom-1 rounded",
              severity === "HIGH" && "ring-2 ring-critical ring-offset-1 ring-offset-surface-2",
            )}
            style={{
              left: pct(Math.min(start, end + 1)),
              // An insertion point gets a sliver, so it can be seen and hovered.
              width: `max(4px, ${((Math.max(end, start) - Math.min(start, end + 1) + 1) / domain) * 100}%)`,
              background: KIND_COLOR[work.kind],
              opacity: work.approximate ? 0.55 : 1,
            }}
          />
        ))}
        {hover && (
          <div
            role="tooltip"
            className="pointer-events-none absolute -top-9 left-0 z-10 rounded border border-border bg-surface-1 px-2 py-1 text-xs whitespace-nowrap shadow"
          >
            {workName(work)} — {linesLabel(work)}
            {severity ? ` — ${severity} collision` : ""}
          </div>
        )}
      </div>
    </li>
  );
}

/** Line numbers under the rows: recessive, a handful of ticks. */
function Axis({ domain }: { domain: number }) {
  const step = Math.max(1, Math.ceil(domain / 5 / 10) * 10);
  const ticks = [];
  for (let line = 1; line <= domain; line += step) ticks.push(line);
  return (
    <div className="mt-1 grid sm:grid-cols-[minmax(0,16rem)_1fr] sm:gap-4" aria-hidden>
      <span className="hidden sm:block" />
      <div className="relative h-4 text-[10px] text-muted">
        {ticks.map((line) => (
          <span
            key={line}
            className="absolute -translate-x-1/2"
            style={{ left: `${((line - 1) / domain) * 100}%` }}
          >
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

import type { History } from "@highground/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { useApi } from "../api.tsx";
import { Severity } from "../components/severity.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";

const WINDOWS = [7, 30, 90, 365] as const;
const LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
const LEVEL_COLOR = {
  HIGH: "var(--status-critical)",
  MEDIUM: "var(--status-serious)",
  LOW: "var(--status-warning)",
} as const;

/** History (PRD §10): collisions over time, hottest files, colliding pairs, agents. */
export function HistoryPage() {
  const { "*": repo = "" } = useParams();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const { orpc } = useApi();
  const history = useQuery(orpc.history.queryOptions({ input: { repo, days } }));

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          History <span className="font-mono text-sm font-normal text-secondary">{repo}</span>
        </h1>
        <div className="ml-auto flex gap-1" role="group" aria-label="Window">
          {WINDOWS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === days ? "default" : "outline"}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {d === 365 ? "1 year" : `${d} days`}
            </Button>
          ))}
        </div>
      </div>
      {history.isPending && <p className="text-muted">Loading…</p>}
      {history.isError && <p role="alert">History is unavailable: {history.error.message}</p>}
      {history.data && <HistoryView history={history.data} />}
    </section>
  );
}

function HistoryView({ history }: { history: History }) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <PerDay days={history.days} />
        <Agents agents={history.agents} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <HottestFiles files={history.files} />
        <Card className="p-4">
          <h2 className="font-semibold">Most-colliding pairs</h2>
          {history.pairs.length === 0 ? (
            <p className="mt-2 text-sm text-secondary">No collisions in this window.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 font-normal">Between</th>
                  <th className="py-1 text-right font-normal">Collisions</th>
                </tr>
              </thead>
              <tbody>
                {history.pairs.map((p) => (
                  <tr key={`${p.a}|${p.b}`} className="border-t border-border">
                    <td className="py-1.5">
                      <div>{p.a}</div>
                      <div className="text-secondary">{p.b}</div>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{p.collisions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

/** Episodes per day, stacked by severity, with a table view of the same numbers. */
function PerDay({ days }: { days: History["days"] }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((d) => d.HIGH + d.MEDIUM + d.LOW);
  const max = Math.max(1, ...totals);
  const height = 160;
  const gap = 2;
  const slot = 100 / days.length;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Collisions per day</h2>
        <ul className="flex gap-3 text-xs text-secondary" aria-label="Legend">
          {LEVELS.map((level) => (
            <li key={level} className="flex items-center gap-1">
              <span
                aria-hidden
                className="size-2.5 rounded-sm"
                style={{ background: LEVEL_COLOR[level] }}
              />
              {level}
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setTable(!table)}>
          {table ? "Show as chart" : "Show as table"}
        </Button>
      </div>
      {table ? (
        <table className="mt-3 w-full text-sm" aria-label="Collisions per day">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-normal">Day</th>
              {LEVELS.map((l) => (
                <th key={l} className="py-1 text-right font-normal">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day} className="border-t border-border tabular-nums">
                <td className="py-1">{d.day}</td>
                <td className="py-1 text-right">{d.HIGH}</td>
                <td className="py-1 text-right">{d.MEDIUM}</td>
                <td className="py-1 text-right">{d.LOW}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative mt-3">
          <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            className="h-40 w-full"
            role="img"
            aria-label={`Collisions per day over ${days.length} days; at most ${max} in a day`}
          >
            {[0.5, 1].map((f) => (
              <line
                key={f}
                x1={0}
                x2={100}
                y1={height - f * height}
                y2={height - f * height}
                stroke="var(--grid)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {days.map((d, i) => {
              let y = height;
              const segments = LEVELS.filter((l) => d[l] > 0);
              return (
                <g key={d.day}>
                  {segments.map((level, j) => {
                    const h = (d[level] / max) * height;
                    y -= h;
                    const top = j === segments.length - 1;
                    return (
                      <rect
                        key={level}
                        x={i * slot + slot * 0.15}
                        width={slot * 0.7}
                        y={y}
                        // A surface-coloured gap separates stacked segments.
                        height={Math.max(0, h - (top ? 0 : gap))}
                        rx={top ? 1 : 0}
                        fill={LEVEL_COLOR[level]}
                        opacity={hover === null || hover === i ? 1 : 0.5}
                      />
                    );
                  })}
                  <rect
                    x={i * slot}
                    width={slot}
                    y={0}
                    height={height}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && days[hover] && (
            <div
              role="tooltip"
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded border border-border bg-surface-1 px-2 py-1 text-xs whitespace-nowrap shadow"
              style={{ left: `${(hover + 0.5) * slot}%` }}
            >
              <div className="font-medium">{days[hover].day}</div>
              {LEVELS.map((l) => (
                <div key={l} className="tabular-nums text-secondary">
                  {l} {days[hover]![l]}
                </div>
              ))}
            </div>
          )}
          <div className="mt-1 flex justify-between text-[10px] text-muted" aria-hidden>
            <span>{days[0]?.day}</span>
            <span>max {max}/day</span>
            <span>{days.at(-1)?.day}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/** A single headline number, so a stat tile rather than a chart. */
function Agents({ agents }: { agents: History["agents"] }) {
  const share =
    agents.warned === 0 ? null : Math.round((agents.changed_course / agents.warned) * 100);
  return (
    <Card className="flex flex-col justify-center p-4">
      <h2 className="text-sm text-secondary">Agents that changed course</h2>
      <p className="mt-1 text-4xl font-semibold tabular-nums">
        {share === null ? "—" : `${share}%`}
      </p>
      <p className="mt-1 text-sm text-secondary">
        {share === null
          ? "No agent was warned at HIGH in this window."
          : `${agents.changed_course} of ${agents.warned} agents warned at HIGH changed course`}
      </p>
    </Card>
  );
}

function HottestFiles({ files }: { files: History["files"] }) {
  const max = Math.max(1, ...files.map((f) => f.collisions));
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Hottest files</h2>
      {files.length === 0 ? (
        <p className="mt-2 text-sm text-secondary">No collisions in this window.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {files.map((f) => (
            <li
              key={f.path}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
            >
              <span className="truncate font-mono text-xs" title={f.path}>
                {f.path}
              </span>
              <span className="flex items-center gap-2 text-xs tabular-nums">
                {f.collisions}
                <Severity level={f.worst} className="px-1 py-0" />
              </span>
              <div className="col-span-2 h-2 rounded-sm bg-surface-2">
                <div
                  className={cn("bar h-2 rounded-sm")}
                  style={{
                    width: `${(f.collisions / max) * 100}%`,
                    background: "var(--sequential)",
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

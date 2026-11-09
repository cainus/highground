import type { Me, Radar, RadarFile } from "@highground/core";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api.tsx";
import { FileRadar } from "../components/file-radar.tsx";

/** The files that hold the viewer's own work, with everyone's work on them. */
function mineOnly(radar: Radar, me: Me | null): RadarFile[] {
  const emails = new Set(me?.emails ?? []);
  return radar.files.filter((file) => file.work.some((w) => emails.has(w.author)));
}

/** Radar (PRD §10), or My work: the same live view filtered to the viewer's own work. */
export function RadarPage({ me, mine }: { me: Me | null; mine: boolean }) {
  const { "*": repo = "" } = useParams();
  const [params] = useSearchParams();
  const focus = params.get("path");
  const { orpc } = useApi();
  const radar = useQuery(orpc.watchRadar.experimental_liveOptions({ input: { repo } }));

  const files = radar.data ? (mine ? mineOnly(radar.data, me) : radar.data.files) : [];
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
      {radar.data && files.length === 0 && (
        <p className="text-secondary">
          {mine
            ? "None of your work is in flight in this repository."
            : "No one is changing anything in this repository right now."}
        </p>
      )}
      <div className="grid gap-4">
        {files.map((file) => (
          <FileRadar
            key={file.path}
            file={file}
            focused={file.path === focus}
            mine={new Set(me?.emails)}
          />
        ))}
      </div>
    </section>
  );
}

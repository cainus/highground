import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button.tsx";

/** How often an open tab asks whether the server has a newer build, besides on return. */
const CHECK_EVERY_MS = 5 * 60_000;
/** Returning to a tab many times a minute checks at most this often. */
const MIN_GAP_MS = 30_000;

/**
 * The build a page loads: its module entry script, which Vite names by a hash of its
 * content, so a different name is a different build.
 */
export function entryScript(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
}

const runningBuild = () =>
  document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;

const fetchLatest = async () => (await fetch("/", { cache: "no-store" })).text();

/**
 * Offers a reload once the server serves a newer dashboard than this tab is running.
 * A dashboard stays open for days, and nothing else would tell it the server changed.
 * It checks when the tab comes back into view and every few minutes; a page that names
 * no build, as under the dev server, is never checked.
 */
export function UpdateNotice({
  current = runningBuild(),
  latest = fetchLatest,
  reload = () => window.location.reload(),
}: {
  current?: string | null;
  latest?: () => Promise<string>;
  reload?: () => void;
}) {
  const [updated, setUpdated] = useState(false);
  const lastCheck = useRef(0);

  useEffect(() => {
    if (current === null || updated) return;
    let live = true;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastCheck.current < MIN_GAP_MS) return;
      lastCheck.current = now;
      latest()
        .then((html) => {
          const served = entryScript(html);
          if (live && served !== null && served !== current) setUpdated(true);
        })
        // A server that is restarting is asked again on the next check.
        .catch(() => {});
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [current, latest, updated]);

  if (!updated) return null;
  return (
    <div
      role="status"
      className="border-b border-border bg-surface-2 px-4 py-2 text-sm text-primary"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <span>Highground has been updated since this tab was opened.</span>
        <Button size="sm" variant="outline" onClick={reload}>
          <RefreshCw aria-hidden className="size-4" />
          Reload
        </Button>
      </div>
    </div>
  );
}

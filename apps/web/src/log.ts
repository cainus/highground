import type { LogLines } from "@highground/core";

type Line = LogLines["lines"][number];

const ENDPOINT = "/api/v1/logs";
const FLUSH_MS = 5_000;
const MAX_BATCH = 50;
/** Under the server's 64 KB body limit, with room for the envelope. */
const MAX_BATCH_BYTES = 60 * 1024;
/** Lines kept while waiting to send; a runaway error loop drops the oldest. */
const MAX_QUEUED = 500;
const encoder = new TextEncoder();
let queue: Line[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let send: (lines: Line[]) => void = () => {};

/** Queues a line; batches go out every few seconds, and with `sendBeacon` as the page goes. */
export function log(level: Line["level"], msg: string, fields: Partial<Line> = {}): void {
  queue.push({
    time: new Date().toISOString(),
    level,
    msg: msg.slice(0, 4000),
    url: location.href.slice(0, 2048),
    ...fields,
  });
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
  if (queue.length >= MAX_BATCH) flush();
  else timer ??= setTimeout(flush, FLUSH_MS);
}

export function logError(error: unknown, msg: string): void {
  const stack = error instanceof Error ? error.stack : undefined;
  log(
    "error",
    `${msg}: ${error instanceof Error ? error.message : String(error)}`,
    stack ? { stack: stack.slice(0, 16_000) } : {},
  );
}

export function flush(): void {
  clearTimeout(timer);
  timer = undefined;
  if (queue.length === 0) return;
  // Always at least one line: a single line is under the limit by the schema's own caps.
  let bytes = 0;
  let count = 0;
  while (count < queue.length && count < MAX_BATCH) {
    bytes += encoder.encode(JSON.stringify(queue[count])).length + 1;
    if (count > 0 && bytes > MAX_BATCH_BYTES) break;
    count++;
  }
  const lines = queue.splice(0, count);
  send(lines);
  if (queue.length > 0) timer = setTimeout(flush, FLUSH_MS);
}

/**
 * Sends the dashboard's errors to the server (PRD §9): `window.onerror`, unhandled
 * rejections, and whatever the app logs, batched, flushed with `sendBeacon` on page hide
 * so the last lines survive navigation.
 */
export function installLogging(): void {
  send = (lines) => {
    const body = JSON.stringify({ lines });
    if (document.visibilityState === "hidden" && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {});
  };
  window.addEventListener("error", (event) =>
    logError(event.error ?? event.message, "uncaught error"),
  );
  window.addEventListener("unhandledrejection", (event) =>
    logError(event.reason, "unhandled rejection"),
  );
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

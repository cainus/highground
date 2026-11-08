/**
 * Open-loop load: requests are sent on an even schedule whether or not earlier ones
 * have answered, as independent clients would send them. (autocannon's rate limit
 * fires each connection's per-second quota back to back at the top of every second,
 * so the server saw bursts no real client population produces.)
 */
import { Agent, request } from "node:http";
import { createHistogram, type RecordableHistogram } from "node:perf_hooks";

export interface Stream {
  name: string;
  perSecond: number;
  next(): { method: "GET" | "POST"; path: string; body?: string };
}

export interface Result {
  name: string;
  latency: RecordableHistogram;
  errors: number;
}

export async function load(url: string, streams: Stream[], seconds: number): Promise<Result[]> {
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });
  const { hostname, port } = new URL(url);
  const results = streams.map((s) => ({ name: s.name, latency: createHistogram(), errors: 0 }));
  const inFlight = new Set<Promise<void>>();

  const send = (stream: Stream, result: Result) => {
    const { method, path, body } = stream.next();
    const started = process.hrtime.bigint();
    const done = new Promise<void>((resolve) => {
      const req = request(
        {
          agent,
          hostname,
          port,
          method,
          path,
          headers: body
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {},
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            if (res.statusCode !== 200) result.errors++;
            result.latency.record(process.hrtime.bigint() - started);
            resolve();
          });
        },
      );
      req.on("error", () => {
        result.errors++;
        resolve();
      });
      req.end(body);
    });
    inFlight.add(done);
    void done.then(() => inFlight.delete(done));
  };

  const start = performance.now();
  const sent = streams.map(() => 0);
  await new Promise<void>((finish) => {
    const tick = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= seconds * 1000) return finish();
      streams.forEach((stream, i) => {
        const due = Math.floor((elapsed * stream.perSecond) / 1000);
        while (sent[i]! < due) {
          sent[i]!++;
          send(stream, results[i]!);
        }
      });
      setTimeout(tick, 1);
    };
    tick();
  });
  await Promise.all(inFlight);
  agent.destroy();
  return results;
}

export const ms = (h: { percentile(p: number): number; max: number }, p?: number) =>
  ((p === undefined ? h.max : h.percentile(p)) / 1e6).toFixed(1);

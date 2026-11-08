import { expect } from "vitest";
import type { RunningServer } from "../src/server.ts";
import type { FakeGitHub } from "./fake-github.ts";

/** The `name=value` part of each Set-Cookie, and the full header for attribute checks. */
export function cookies(res: Response): Map<string, { pair: string; header: string }> {
  return new Map(
    res.headers.getSetCookie().map((header) => {
      const pair = header.split(";")[0]!;
      return [pair.split("=")[0]!, { pair, header }];
    }),
  );
}

/** Signs in through the whole web flow as the owner of `token`; returns the session cookie. */
export async function signIn(s: RunningServer, gh: FakeGitHub, token: string): Promise<string> {
  gh.webUser = token;
  try {
    const start = await fetch(`${s.url}/auth/login`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const oauth = cookies(start).get("hg_oauth")!.pair;
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = await fetch(authorize.headers.get("location")!, {
      redirect: "manual",
      headers: { cookie: oauth },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    return cookies(callback).get("hg_session")!.pair;
  } finally {
    gh.webUser = undefined;
  }
}

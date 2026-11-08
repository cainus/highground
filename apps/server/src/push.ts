import type { Agent } from "node:https";
import type { PushSubscription } from "@highground/core";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { sendNotification, WebPushError } from "web-push";
import type { Authorizer } from "./auth.ts";
import { pushSubscriptions } from "./db/schema.ts";
import type { EpisodeSide, HighEpisode } from "./recorder.ts";
import type { Sessions } from "./sessions.ts";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or `https:` contact for push services. */
  subject: string;
  /** The HTTPS agent to reach push services with; Node's default when unset. */
  agent?: Agent;
}

export interface PushOptions {
  sql: postgres.Sql;
  vapid: VapidConfig;
  sessions: Sessions;
  auth: Authorizer;
  onError?: (error: unknown) => void;
}

/** What a push carries; the service worker shows it and opens `url` on click. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const describe = (side: EpisodeSide) =>
  side.actor.type === "cli" && side.kind === "live"
    ? side.author
    : `${side.author} (${side.kind === "live" ? side.actor.id : `${side.kind} ${side.actor.id}`})`;

/**
 * Web Push for HIGH collisions (PRD §10). The owners of an episode's live and parked
 * sides are found through their sessions' verified emails, and told only if their own
 * token can still read the repository; each of their subscribed browsers gets one
 * message, encrypted for that browser. A subscription the push service has dropped is
 * forgotten.
 */
export class Push {
  readonly #options: PushOptions;
  readonly #db;

  constructor(options: PushOptions) {
    this.#options = options;
    this.#db = drizzle(options.sql);
  }

  get publicKey(): string {
    return this.#options.vapid.publicKey;
  }

  async subscribe(githubId: number, subscription: PushSubscription): Promise<void> {
    const values = {
      endpoint: subscription.endpoint,
      githubId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    };
    await this.#db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
  }

  async unsubscribe(githubId: number, endpoint: string): Promise<void> {
    const [row] = await this.#db
      .select({ githubId: pushSubscriptions.githubId })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
    // Only the browser's own user may drop it.
    if (row?.githubId === githubId) {
      await this.#db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    }
  }

  async notify(episode: HighEpisode): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const [own, peer] of [
      [episode.a, episode.b],
      [episode.b, episode.a],
    ] as const) {
      if (own.kind === "pushed") continue;
      const users = await this.#readers(own.author, episode.repo);
      if (users.length === 0) continue;
      const message: PushMessage = {
        title: `HIGH: ${episode.path}`,
        body: `${describe(peer)} is changing the same lines in ${episode.repo}`,
        url: `/radar/${episode.repo}?path=${encodeURIComponent(episode.path)}`,
        tag: `episode-${episode.id}`,
      };
      const browsers = await this.#db
        .select()
        .from(pushSubscriptions)
        .where(inArray(pushSubscriptions.githubId, users));
      for (const browser of browsers) sends.push(this.#send(browser, message));
    }
    await Promise.all(sends);
  }

  /** The GitHub users behind an author's email whose own tokens can read the repository. */
  async #readers(author: string, repo: string): Promise<number[]> {
    const users = new Set<number>();
    for (const { githubId, token } of await this.#options.sessions.withEmail(author)) {
      if (users.has(githubId)) continue;
      const allowed = await this.#options.auth.authorize(token, repo).then(
        () => true,
        () => false,
      );
      if (allowed) users.add(githubId);
    }
    return [...users];
  }

  async #send(browser: typeof pushSubscriptions.$inferSelect, message: PushMessage): Promise<void> {
    try {
      await sendNotification(
        { endpoint: browser.endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth } },
        JSON.stringify(message),
        {
          vapidDetails: {
            subject: this.#options.vapid.subject,
            publicKey: this.#options.vapid.publicKey,
            privateKey: this.#options.vapid.privateKey,
          },
          TTL: 3600,
          urgency: "high",
          topic: message.tag.slice(0, 32),
          ...(this.#options.vapid.agent ? { agent: this.#options.vapid.agent } : {}),
        },
      );
    } catch (error) {
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        await this.#db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, browser.endpoint));
        return;
      }
      this.#options.onError?.(error);
    }
  }
}

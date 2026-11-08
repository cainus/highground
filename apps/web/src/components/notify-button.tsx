import { useQuery } from "@tanstack/react-query";
import { Bell, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { useApi } from "../api.tsx";
import { logError } from "../log.ts";
import { Button } from "./ui/button.tsx";

/** A VAPID public key, base64url, as the bytes `pushManager.subscribe` wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const supported = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in globalThis;

/** Turns Web Push on for this browser: HIGH collisions with the user's work, even with no tab open. */
export function NotifyButton() {
  const { client, orpc } = useApi();
  const key = useQuery({ ...orpc.pushKey.queryOptions(), retry: false, staleTime: Infinity });
  const [state, setState] = useState<"off" | "on" | "working" | "blocked">("off");

  useEffect(() => {
    if (!supported()) return;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((existing) => existing && setState("on"))
      .catch(() => {});
  }, []);

  if (!supported() || !key.data) return null;

  async function enable(publicKey: string) {
    setState("working");
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        setState("blocked");
        return;
      }
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      const json = subscription.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      await client.subscribePush({ endpoint: json.endpoint, keys: json.keys });
      setState("on");
    } catch (error) {
      logError(error, "push subscription failed");
      setState("off");
    }
  }

  if (state === "on")
    return (
      <span className="inline-flex items-center gap-1 text-sm text-secondary">
        <BellRing aria-hidden className="size-4" /> Notifications on
      </span>
    );
  if (state === "blocked")
    return (
      <span className="text-sm text-secondary">Notifications are blocked in this browser</span>
    );
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={state === "working"}
      onClick={() => void enable(key.data.public_key)}
    >
      <Bell aria-hidden className="size-4" /> Notify me
    </Button>
  );
}

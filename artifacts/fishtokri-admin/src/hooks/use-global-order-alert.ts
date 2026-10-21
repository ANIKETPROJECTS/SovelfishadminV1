import { useEffect, useRef } from "react";
import { apiFetch, getCurrentAdminScope } from "@/lib/api";

const CHANNEL_NAME = "fishtokri-order-alert";
const POLL_MS = 5000;

/**
 * Global order-alert hook — mount once in the app shell (Layout).
 *
 * • Polls /api/orders?status=pending every 5 s regardless of which page is open.
 * • BroadcastChannel deduplicates across open tabs: the first tab to detect a new
 *   order plays the sound and tells every other tab to mark those IDs as known so
 *   they stay silent.
 * • Shows a browser Notification when the page is hidden / minimised so the user
 *   hears / sees the alert even when they're looking at another tab or app.
 */
export function useGlobalOrderAlert() {
  const knownIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // ── BroadcastChannel + Notification permission ──────────────────────────────
  useEffect(() => {
    // Ask for notification permission once (user gesture not required for this)
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }

    // Open a channel shared by all tabs of this origin
    if ("BroadcastChannel" in window) {
      const ch = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = ch;

      // When ANOTHER tab plays the alert, absorb those IDs so we don't re-alert
      ch.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "new-orders" && Array.isArray(e.data.ids)) {
          for (const id of e.data.ids as string[]) {
            knownIdsRef.current.add(id);
          }
        }
      };

      return () => {
        ch.close();
        channelRef.current = null;
      };
    }
  }, []);

  // ── Polling ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const scope = getCurrentAdminScope();
        if (!scope.role) return; // not logged in yet

        // Build a lightweight query — only pending orders for today (IST)
        const now = new Date();
        const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        const todayIST = istNow.toISOString().slice(0, 10);

        const params = new URLSearchParams({
          status: "pending",
          date: todayIST,
          limit: "200",
        });

        // Scope to this admin's hub(s) when not master_admin
        if (scope.role !== "master_admin") {
          if (scope.subHubIds.length > 0) {
            params.set("subHubId", scope.subHubIds[0]);
          } else if (scope.superHubIds.length > 0) {
            params.set("superHubId", scope.superHubIds[0]);
          }
        }

        const data = await apiFetch(`/api/orders?${params}`);
        const orders: any[] = data.orders ?? [];
        const currentIds = new Set(orders.map((o: any) => String(o._id)));

        if (!initializedRef.current) {
          // First load — seed without alerting
          knownIdsRef.current = currentIds;
          initializedRef.current = true;
          return;
        }

        // Find IDs we haven't seen before
        const newIds: string[] = [];
        for (const id of currentIds) {
          if (!knownIdsRef.current.has(id)) newIds.push(id);
        }
        // Absorb all current IDs
        for (const id of currentIds) knownIdsRef.current.add(id);

        if (newIds.length === 0) return;

        // ── Play sound ───────────────────────────────────────────────────────
        const audio = new Audio("/order-alert.wav");
        audio.play().catch(() => {
          // Autoplay may be blocked until the user interacts with the page
        });

        // ── Browser Notification when tab is not visible ─────────────────────
        if (
          document.visibilityState !== "visible" &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          new Notification("🔔 New Order!", {
            body:
              newIds.length === 1
                ? "1 new order arrived on Fresh Stock Xchange"
                : `${newIds.length} new orders arrived on Fresh Stock Xchange`,
            icon: "/favicon.ico",
            tag: "fishtokri-new-order",
            renotify: true,
          });
        }

        // ── Tell other open tabs — they should NOT re-alert for these IDs ────
        channelRef.current?.postMessage({ type: "new-orders", ids: newIds });
      } catch {
        // Silent fail — never disrupt the UI
      }
    };

    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);
}

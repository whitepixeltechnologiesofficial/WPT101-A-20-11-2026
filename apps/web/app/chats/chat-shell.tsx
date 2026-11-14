"use client";

/**
 * Post-link shell: where Web lands after a scan (WEB-R1.2).
 *
 * WEB-R1.4: Web is its own device with its own backend session. It never
 * talks to the phone, so nothing here blocks, disables or waits on the
 * phone's reachability.
 *
 * WEB-R1.5: reconnects and catch-up are INVISIBLE. There is no syncing
 * label, spinner, banner, toast or console message. Socket reconnects,
 * token refresh, the reconnect drain and the `queue_more` poll all feed
 * the background inbox (lib/inbox.ts); the UI only ever shows content.
 *
 * WEB-R1.6: log-off always ends the session here at once; the server is
 * told now, or as soon as the network returns (lib/pending-logoff.ts).
 *
 * WEB-R1.8: `force_logout` (new-phone login) ends the session immediately,
 * with no grace period, and the app shows a clear "rescan" state.
 *
 * Chat list content arrives with WEB-2.1.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createSessionChannel, LinkingError } from "@wpt/api-client";
import { API_BASE_URL, sessionApi } from "../lib/api";
import { addMessages } from "../lib/inbox";
import { logOff as terminateSession } from "../lib/pending-logoff";
import { saveSession, type WebSession } from "../lib/session-store";

export type EndReason = "logoff" | "logoff_queued" | "force_logout" | "revoked";

export function ChatShell({ session, onEnded }: { session: WebSession; onEnded: (r: EndReason) => void }) {
  const [loggingOff, setLoggingOff] = useState(false);

  // Latest credentials; refresh rotates them.
  const sessionRef = useRef(session);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    let ended = false;
    const end = (r: EndReason) => {
      if (ended) return;
      ended = true;
      onEndedRef.current(r);
    };

    const channel = createSessionChannel({
      baseUrl: API_BASE_URL,
      userId: session.userId,
      deviceId: session.deviceId,
      getAccessToken: () => sessionRef.current.accessToken,
    });

    // Rotate the access token once, then retry `fn`. A rejected refresh
    // means the session is gone server-side.
    let refreshing: Promise<boolean> | null = null;
    const refresh = () =>
      (refreshing ??= sessionApi
        .refresh(sessionRef.current.refreshToken)
        .then((next) => {
          sessionRef.current = { ...sessionRef.current, ...next };
          saveSession(sessionRef.current);
          return true;
        })
        .catch((err: unknown) => {
          if (err instanceof LinkingError && err.status === 401) end("revoked");
          return false;
        })
        .finally(() => {
          refreshing = null;
        }));

    const pollBacklog = async () => {
      try {
        addMessages((await sessionApi.relayPoll(sessionRef.current.accessToken)).messages);
      } catch (err) {
        if (!(err instanceof LinkingError) || err.status !== 401) return; // retried on next reconnect
        if (err.code === "SESSION_REVOKED") return end("revoked");
        if (await refresh()) void pollBacklog();
      }
    };

    const offs = [
      channel.onForceLogout(() => end("force_logout")),
      channel.onMessage((m) => addMessages([m])),
      channel.onQueueMore(() => void pollBacklog()),
      channel.onAuthError(async (message) => {
        if (message === "Session revoked" || message === "Session not found") return end("revoked");
        // Access token expired: rotate silently and reconnect.
        if (message === "Invalid token" && (await refresh())) channel.socket.connect();
      }),
    ];

    return () => {
      offs.forEach((off) => off());
      channel.close();
    };
  }, [session.userId, session.deviceId]);

  const logOff = useCallback(async () => {
    setLoggingOff(true);
    const { accessToken, refreshToken } = sessionRef.current;
    const result = await terminateSession({ accessToken, refreshToken });
    onEndedRef.current(result === "confirmed" ? "logoff" : "logoff_queued");
  }, []);

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">WPT</span>
        <button type="button" className="ghost" onClick={logOff} disabled={loggingOff}>
          Log out
        </button>
      </header>

      <section className="chat-list" aria-label="Chats">
        <input className="search" type="search" placeholder="Search chats" aria-label="Search chats" />
        <div className="empty">
          <p>No chats yet</p>
          <p className="muted">Start a conversation from your phone or with New chat.</p>
        </div>
      </section>
    </div>
  );
}

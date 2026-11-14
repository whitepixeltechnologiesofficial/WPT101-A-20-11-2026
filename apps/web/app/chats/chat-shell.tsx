"use client";

/**
 * Post-link shell: where Web lands after a scan (WEB-R1.2), and the
 * WEB-R1.4 guarantee: Web keeps working when the paired phone is offline.
 *
 * Web is its own device with its own backend session (TAD session
 * architecture). It never talks to the phone directly, so the phone's
 * reachability is shown as an informational, non-blocking banner only.
 * Nothing here disables input or shows a modal because of it.
 *
 * Chat list content arrives with WEB-2.1; this shell owns the session.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createSessionChannel, LinkingError } from "@wpt/api-client";
import { API_BASE_URL, sessionApi } from "../lib/api";
import { saveSession, type WebSession } from "../lib/session-store";

export type EndReason = "logoff" | "force_logout" | "revoked";

export function ChatShell({ session, onEnded }: { session: WebSession; onEnded: (r: EndReason) => void }) {
  const [phoneOnline, setPhoneOnline] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [loggingOff, setLoggingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Latest credentials; refresh rotates them.
  const sessionRef = useRef(session);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    const channel = createSessionChannel({
      baseUrl: API_BASE_URL,
      userId: session.userId,
      deviceId: session.deviceId,
      getAccessToken: () => sessionRef.current.accessToken,
    });
    let refreshing = false;

    channel.socket.on("connect", () => setConnected(true));
    channel.socket.on("disconnect", () => setConnected(false));
    const offForce = channel.onForceLogout(() => onEndedRef.current("force_logout"));
    const offPresence = channel.onPhonePresence((p) => setPhoneOnline(p.online));
    const offAuth = channel.onAuthError(async (message) => {
      if (message === "Session revoked" || message === "Session not found") {
        onEndedRef.current("revoked");
        return;
      }
      if (message !== "Invalid token" || refreshing) return;
      // Access token expired: rotate it, then reconnect.
      refreshing = true;
      try {
        const next = await sessionApi.refresh(sessionRef.current.refreshToken);
        sessionRef.current = { ...sessionRef.current, ...next };
        saveSession(sessionRef.current);
        channel.socket.connect();
      } catch (err) {
        if (err instanceof LinkingError && err.status === 401) onEndedRef.current("revoked");
      } finally {
        refreshing = false;
      }
    });

    return () => {
      offForce();
      offPresence();
      offAuth();
      channel.close();
    };
  }, [session.userId, session.deviceId]);

  const logOff = useCallback(async () => {
    setLoggingOff(true);
    setError(null);
    try {
      await sessionApi.logoff(sessionRef.current.accessToken);
      onEndedRef.current("logoff");
    } catch (err) {
      if (err instanceof LinkingError && err.status === 401) {
        onEndedRef.current("logoff"); // already revoked server-side
        return;
      }
      setError("Couldn’t reach WPT to log out. Check your connection and try again.");
      setLoggingOff(false);
    }
  }, []);

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">WPT</span>
        <span className={connected ? "dot dot-on" : "dot"} title={connected ? "Connected" : "Reconnecting…"} />
        <button type="button" className="ghost" onClick={logOff} disabled={loggingOff}>
          {loggingOff ? "Logging out…" : "Log out"}
        </button>
      </header>

      {phoneOnline === false ? (
        <div className="banner" role="status">
          Your phone is offline. WPT Web keeps working: messages go through the WPT server.
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

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

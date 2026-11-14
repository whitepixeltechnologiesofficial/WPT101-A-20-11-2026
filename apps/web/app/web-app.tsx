"use client";

/**
 * Root client component: linked → chat shell, otherwise → QR linking.
 *
 * WEB-R1.7: the session lives in localStorage, so closing the tab (or the
 * browser) and reopening the site resumes it with no rescan. Only an
 * explicit log-off (WEB-R1.6), a new-phone login (WEB-R1.8) or a server-side
 * revocation ends it. Nothing here reacts to unload/pagehide.
 */

import { useCallback, useEffect, useState } from "react";
import type { LinkedPayload } from "@wpt/shared";
import { QrLink } from "./link/qr-link";
import { ChatShell, type EndReason } from "./chats/chat-shell";
import { clearSession, loadSession, saveSession, type WebSession } from "./lib/session-store";
import { clearIdentity } from "./lib/identity";
import { clearInbox } from "./lib/inbox";
import { startPendingLogoffRetry } from "./lib/pending-logoff";

const END_NOTICES: Record<EndReason, string | undefined> = {
  logoff: undefined,
  logoff_queued: "You’re logged out. This browser will finish signing out with WPT as soon as it’s back online.",
  force_logout: "Your session ended because WPT was opened on a new phone. Scan again to link.",
  revoked: "Your session ended. Scan again to link.",
};

export function WebApp() {
  // undefined = not read from storage yet (avoids a QR flash for linked tabs).
  const [session, setSession] = useState<WebSession | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    setSession(loadSession());
    return startPendingLogoffRetry();
  }, []);

  const onLinked = useCallback((p: LinkedPayload) => {
    saveSession(p);
    setNotice(undefined);
    setSession(p);
  }, []);

  const onEnded = useCallback((reason: EndReason) => {
    clearSession();
    clearIdentity(); // next link is a new device
    clearInbox();
    setNotice(END_NOTICES[reason]);
    setSession(null);
  }, []);

  if (session === undefined) return null;
  return session ? (
    <ChatShell key={session.sessionId} session={session} onEnded={onEnded} />
  ) : (
    <QrLink onLinked={onLinked} notice={notice} />
  );
}

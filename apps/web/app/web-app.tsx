"use client";

/** Root client component: linked → chat shell, otherwise → QR linking. */

import { useCallback, useEffect, useState } from "react";
import type { LinkedPayload } from "@wpt/shared";
import { QrLink } from "./link/qr-link";
import { ChatShell, type EndReason } from "./chats/chat-shell";
import { clearSession, loadSession, saveSession, type WebSession } from "./lib/session-store";
import { clearIdentity } from "./lib/identity";

const END_NOTICES: Record<EndReason, string | undefined> = {
  logoff: undefined,
  force_logout: "You were logged out because WPT was opened on a new phone. Scan again to link.",
  revoked: "This browser is no longer linked. Scan again to link.",
};

export function WebApp() {
  // undefined = not read from storage yet (avoids a QR flash for linked tabs).
  const [session, setSession] = useState<WebSession | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    setSession(loadSession());
  }, []);

  const onLinked = useCallback((p: LinkedPayload) => {
    saveSession(p);
    setNotice(undefined);
    setSession(p);
  }, []);

  const onEnded = useCallback((reason: EndReason) => {
    clearSession();
    clearIdentity(); // next link is a new device
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

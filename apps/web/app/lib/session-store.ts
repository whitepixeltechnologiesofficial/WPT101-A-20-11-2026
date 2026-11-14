/**
 * Web's linked-session credentials, as pushed by `accountLinked`.
 *
 * Kept in localStorage so closing and reopening the tab keeps the session
 * (WEB-R1.7). The session belongs to THIS browser device. Nothing in it
 * depends on the phone being reachable (WEB-R1.4).
 */

import type { LinkedPayload } from "@wpt/shared";

const KEY = "wpt.web.session";

export type WebSession = LinkedPayload;

export function loadSession(): WebSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<WebSession>;
    return s.accessToken && s.refreshToken && s.userId && s.deviceId && s.sessionId
      ? (s as WebSession)
      : null;
  } catch {
    return null;
  }
}

export function saveSession(s: WebSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: session lasts for this tab only */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

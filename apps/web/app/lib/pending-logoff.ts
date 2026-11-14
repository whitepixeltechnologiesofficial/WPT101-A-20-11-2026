/**
 * WEB-R1.6 edge case: log-off while offline.
 *
 * Log-off always ends the session in THIS browser immediately (credentials
 * removed, back to the QR). If the server could not be told, the
 * termination is queued here and re-sent until the server confirms, on
 * app start, whenever the browser comes back online, and every 30s.
 * The backend session is therefore never left valid indefinitely.
 *
 * Distinct from closing the tab (WEB-R1.7): nothing in the app logs off on
 * unload, so closing a tab keeps the session.
 */

import { CLIENT_ERRORS, LinkingError } from "@wpt/api-client";
import { sessionApi } from "./api";

const KEY = "wpt.web.pendingLogoff";
const RETRY_MS = 30_000;

interface PendingLogoff {
  accessToken: string;
  refreshToken: string;
}

function read(): PendingLogoff[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as PendingLogoff[];
  } catch {
    return [];
  }
}

function write(list: PendingLogoff[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

export function hasPendingLogoff(): boolean {
  return read().length > 0;
}

const isNetwork = (e: unknown) =>
  e instanceof LinkingError && (e.code === CLIENT_ERRORS.unreachable || e.code === CLIENT_ERRORS.timeout);

/**
 * Tell the server this session is over. Resolves "done" once the server
 * has revoked it (or already had), "offline" if it couldn't be reached.
 */
async function terminate(p: PendingLogoff): Promise<"done" | "offline"> {
  try {
    await sessionApi.logoff(p.accessToken);
    return "done";
  } catch (e) {
    if (isNetwork(e)) return "offline";
    if (!(e instanceof LinkingError) || e.status !== 401 || e.code !== "INVALID_TOKEN") {
      return "done"; // revoked already (SESSION_REVOKED) or not a web device
    }
  }
  // The access token expired while we were offline: rotate it, then log off.
  try {
    const next = await sessionApi.refresh(p.refreshToken);
    await sessionApi.logoff(next.accessToken);
    return "done";
  } catch (e) {
    return isNetwork(e) ? "offline" : "done"; // refresh rejected → session already dead
  }
}

let flushing: Promise<void> | null = null;

/** Send every queued termination; keep only the ones that couldn't reach the server. */
export function flushPendingLogoffs(): Promise<void> {
  flushing ??= (async () => {
    const left: PendingLogoff[] = [];
    for (const p of read()) if ((await terminate(p)) === "offline") left.push(p);
    write(left);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/**
 * Log off: try now; if the network is down, queue it.
 * Returns whether the server already confirmed.
 */
export async function logOff(p: PendingLogoff): Promise<"confirmed" | "queued"> {
  if ((await terminate(p)) === "done") return "confirmed";
  write([...read(), p]);
  return "queued";
}

/** Retry queued terminations on start, on `online`, and periodically. */
export function startPendingLogoffRetry(): () => void {
  void flushPendingLogoffs();
  const onOnline = () => void flushPendingLogoffs();
  window.addEventListener("online", onOnline);
  const timer = setInterval(() => {
    if (hasPendingLogoff()) void flushPendingLogoffs();
  }, RETRY_MS);
  return () => {
    window.removeEventListener("online", onOnline);
    clearInterval(timer);
  };
}

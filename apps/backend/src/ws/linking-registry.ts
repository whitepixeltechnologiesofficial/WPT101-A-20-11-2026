/**
 * BE-6.1 — Linking-channel registry (TAD §8.6, §12.1).
 *
 * Web has no account yet when it opens this channel, so it cannot use
 * the authenticated socket.io namespace (app.ts's io.use() requires a
 * JWT + userId + deviceId — see initSocketRegistry/registerSocket in
 * ./socket-registry.ts, reused as-is and unmodified in behavior).
 *
 * Instead Web connects to a separate, deliberately UNauthenticated
 * socket.io namespace ("/linking", wired up in app.ts) and emits a
 * `register` event carrying:
 *   - a linking token IT generated client-side (this is the same value
 *     encoded into the QR code shown to the phone)
 *   - its identity bundle (identityPublicKey, optional signingPublicKey)
 *     — generated and held locally in the browser; only the public
 *     halves ever reach the backend, same as every other device type.
 *
 * Security for this pre-auth channel comes from the token itself: high
 * entropy, single-use, and a SERVER-STAMPED 60s TTL (created_at is set
 * here, from Date.now(), never trusted from the client) — not from any
 * request-level auth, because Web doesn't have credentials yet.
 *
 * In-memory, single-instance store — same tradeoff already accepted by
 * middleware/rate-limit.ts and the `connections` map in
 * ./socket-registry.ts. Fine for the current single-instance deployment;
 * would need a shared store (Redis) to scale horizontally.
 *
 * EDGE CASE (spec): Web's socket can drop between scan and push. This
 * registry is keyed by TOKEN, not by socket id, so:
 *   - a reconnect with the same token, within the 60s TTL, rejoins the
 *     same room and is handed `deliveredPayload` immediately if the
 *     phone's scan already completed while Web was briefly offline;
 *   - if the backend transaction in routes/linking.ts fails, it calls
 *     rollbackLinkingConsumption() so the SAME token is still usable
 *     for a retry within whatever's left of the TTL — the link never
 *     half-completes (either Web gets tokens, or nothing changed and
 *     the old browser is still linked).
 */

import type { Namespace, Socket } from "socket.io";
import {
  LINKING_EVENTS,
  LINKING_TOKEN_PATTERN,
  LINKING_TOKEN_TTL_MS,
  type LinkedPayload,
  type LinkExpiredPayload,
  type LinkingIdentityBundle,
  type LinkingRegisterError,
  type LinkingScanError,
} from "@wpt/shared";

// Shapes come from @wpt/shared (linking.ts): the WEB-R1.0 contract that the
// Web client and its mock also compile against. Do not redefine them here.
export type { LinkedPayload, LinkingIdentityBundle };

const TTL_MS = LINKING_TOKEN_TTL_MS;
const SWEEP_INTERVAL_MS = 5_000;

/**
 * Tokens that expired or were used are remembered so they can NEVER be
 * registered again (WEB-R1.3: no token valid past 60s under any
 * circumstance, including a re-register that would restart the clock).
 * Kept for an hour to bound memory; tokens are 256-bit CSPRNG values.
 */
const TOMBSTONE_RETENTION_MS = 60 * 60_000;
type Tombstone = { kind: "expired" | "used"; at: number };
const tombstones = new Map<string, Tombstone>();

function tombstone(token: string, kind: Tombstone["kind"]): void {
  if (!tombstones.has(token)) tombstones.set(token, { kind, at: Date.now() });
}

type LinkingEntry = {
  createdAt: number;
  identity: LinkingIdentityBundle;
  socketId: string | null;
  /** Set the instant a scan attempt starts consuming this token — blocks concurrent/replay scans even before the DB transaction begins. */
  locked: boolean;
  deliveredPayload: LinkedPayload | null;
};

const entries = new Map<string, LinkingEntry>();
let nsRef: Namespace | null = null;

/** Called once from app.ts after the "/linking" namespace is created. */
export function initLinkingNamespace(ns: Namespace): void {
  nsRef = ns;
}

function room(token: string): string {
  return `link:${token}`;
}

function isExpired(entry: LinkingEntry, now = Date.now()): boolean {
  return now - entry.createdAt > TTL_MS;
}

/**
 * Basic shape check on a client-supplied token before it touches the
 * map — real entropy/uniqueness is Web's responsibility (it generates
 * the token), this just rejects obviously-malformed input cheaply.
 */
export function isPlausibleLinkingToken(token: unknown): token is string {
  return typeof token === "string" && LINKING_TOKEN_PATTERN.test(token);
}

/**
 * Web (re)registers on the linking channel. Idempotent for reconnects
 * of the SAME token within its TTL: rejoins the socket.io room and
 * returns any payload that was already pushed while Web was offline.
 *
 * A brand-new token always wins over an expired stale entry with the
 * same key (extremely unlikely collision, but don't resurrect a dead
 * entry's identity bundle under a reused token string).
 */
export function registerLinkingSocket(
  socket: Socket,
  token: string,
  identity: LinkingIdentityBundle,
):
  | { ok: true; expiresAt: string; deliveredPayload: LinkedPayload | null }
  | { ok: false; error: LinkingRegisterError } {
  const now = Date.now();
  let entry = entries.get(token);

  if (entry && isExpired(entry, now)) {
    expireEntry(token);
    entry = undefined;
  }

  if (!entry) {
    // Single use: an expired or consumed token never comes back, so a
    // re-register can't restart its 60s clock.
    const tomb = tombstones.get(token);
    if (tomb) {
      return { ok: false, error: tomb.kind === "used" ? "TOKEN_ALREADY_USED" : "TOKEN_EXPIRED" };
    }
    entry = {
      createdAt: now,
      identity,
      socketId: null,
      locked: false,
      deliveredPayload: null,
    };
    entries.set(token, entry);
  } else if (entry.identity.identityPublicKey !== identity.identityPublicKey) {
    // The token is visible to anyone who can see the screen; the identity
    // key is not. Only the browser that registered the token may rejoin its
    // room. Otherwise a photographed QR, registered from another browser
    // within the TTL, would be handed the replayed accountLinked credentials.
    return { ok: false, error: "TOKEN_ALREADY_USED" };
  }

  entry.socketId = socket.id;
  socket.join(room(token));

  return {
    ok: true,
    expiresAt: new Date(entry.createdAt + TTL_MS).toISOString(),
    deliveredPayload: entry.deliveredPayload,
  };
}

/** Drop an expired entry, remember it, and tell a still-connected Web. */
function expireEntry(token: string): void {
  entries.delete(token);
  tombstone(token, "expired");
  const payload: LinkExpiredPayload = { reason: "ttl" };
  nsRef?.to(room(token)).emit(LINKING_EVENTS.linkExpired, payload);
}

/** Drop the socket id on disconnect — the entry itself survives until TTL/consumption, so a reconnect within the window still works. */
export function unregisterLinkingSocket(socket: Socket): void {
  for (const entry of entries.values()) {
    if (entry.socketId === socket.id) {
      entry.socketId = null;
    }
  }
}

/**
 * Synchronous check-and-lock for the link-on-scan flow. Returns the
 * entry (now locked) if the token is known, unexpired, and not already
 * locked by another in-flight/completed scan — else null.
 *
 * MUST be called with no `await` between this and the caller's next
 * step — Node's single-threaded event loop makes the check-and-set
 * atomic only up to the first await, which is exactly what makes two
 * concurrent scans of the same token unable to both pass.
 */
export function tryConsumeLinkingToken(
  token: string,
): { entry: LinkingEntry } | { error: Exclude<LinkingScanError, "INVALID_TOKEN" | "LINK_FAILED"> } {
  const entry = entries.get(token);
  if (!entry) {
    // Distinct reasons so the phone can say "QR expired, refresh it"
    // rather than a generic failure (WEB-R1.0 / WEB-R1.3 edge case).
    const tomb = tombstones.get(token);
    if (tomb) return { error: tomb.kind === "used" ? "TOKEN_ALREADY_USED" : "TOKEN_EXPIRED" };
    return { error: "TOKEN_UNKNOWN" };
  }
  if (isExpired(entry)) {
    expireEntry(token);
    return { error: "TOKEN_EXPIRED" };
  }
  if (entry.locked) return { error: "TOKEN_ALREADY_USED" }; // used, or a scan is in flight
  entry.locked = true;
  return { entry };
}

/**
 * Undo tryConsumeLinkingToken() after a failed link attempt (e.g. the
 * DB transaction threw) so the same token can be retried within its
 * remaining TTL, per the "must not half-complete" edge case.
 */
export function rollbackLinkingConsumption(token: string): void {
  const entry = entries.get(token);
  if (entry) entry.locked = false;
}

/**
 * Push the issued tokens to Web's linking-channel room AFTER the DB
 * transaction has committed. The payload is also stashed on the entry
 * so a reconnect within the TTL still receives it even if Web wasn't
 * connected at the moment of the push (see EDGE CASE above) — Web must
 * be TOLD, not left to poll.
 */
export function pushLinkedPayload(token: string, payload: LinkedPayload): void {
  const entry = entries.get(token);
  if (entry) entry.deliveredPayload = payload;
  tombstone(token, "used");
  nsRef?.to(room(token)).emit(LINKING_EVENTS.accountLinked, payload);
}

// Periodic sweep for entries whose 60s TTL has elapsed — mirrors the
// cleanup pattern already used by middleware/rate-limit.ts. Notifies a
// still-connected Web socket so it can regenerate a fresh QR instead of
// silently going stale (mirrors the WEB-R1.0 mock's `qrExpired` event).
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of entries) {
    if (isExpired(entry, now)) expireEntry(token);
  }
  for (const [token, t] of tombstones) {
    if (now - t.at > TOMBSTONE_RETENTION_MS) tombstones.delete(token);
  }
}, SWEEP_INTERVAL_MS).unref();

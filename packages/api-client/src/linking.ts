/**
 * WEB-R1.0 / BE-6.1 — the Web-linking client.
 *
 * Web talks to the linking backend ONLY through this module. It speaks the
 * contract in @wpt/shared (linking.ts), which both the WEB-R1.0 mock
 * (../mock/server.ts) and the real backend (apps/backend, BE-6.1) serve.
 * Pointing Web at one or the other is purely a matter of `baseUrl`
 * (API_BASE_URL). Nothing here, and nothing in apps/web, branches on
 * "mock vs real".
 */

import { io, type Socket } from "socket.io-client";
import {
  API_VERSION,
  LINKING_API,
  LINKING_EVENTS,
  LINKING_SOCKET_NAMESPACE,
  LINKING_TOKEN_BYTES,
  SESSION_EVENTS,
  SOCKET_PATH,
  SOCKET_TRANSPORT_FALLBACK,
  SOCKET_TRANSPORT_PRIMARY,
  type LinkedPayload,
  type LinkExpiredPayload,
  type LinkingIdentityBundle,
  type LinkingLogoffResponse,
  type LinkingRegisterAck,
  type LinkingRegisterRequest,
  type LinkingScanResponse,
  type PhonePresencePayload,
  type RefreshResponse,
  type RelayMessage,
  type RelayPollResponse,
  type RelaySendRequest,
} from "@wpt/shared";
import { createRealtimeClient } from "./socket.js";

// ── Errors ─────────────────────────────────────────────────────────────

/**
 * A typed failure from the linking/session API. `code` is the server's
 * error string from the contract (e.g. "TOKEN_EXPIRED") or one of
 * CLIENT_ERRORS.
 */
export class LinkingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(code);
    this.name = "LinkingError";
  }

  /** The QR/token is past its 60s and must be regenerated. */
  get isExpired(): boolean {
    return this.code === "TOKEN_EXPIRED";
  }
}

/** Client-side codes (never sent by a server). */
export const CLIENT_ERRORS = {
  /** Could not reach the linking channel / API at all. */
  unreachable: "CHANNEL_UNREACHABLE",
  /** Channel connected but did not ack in time. */
  timeout: "CHANNEL_TIMEOUT",
} as const;

// ── Token ──────────────────────────────────────────────────────────────

/**
 * WEB-R1.2: Web generates the linking token itself (TAD §12.1) from the
 * platform CSPRNG. Never Math.random().
 */
export function createLinkingToken(): string {
  const bytes = new Uint8Array(LINKING_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Linking channel ────────────────────────────────────────────────────

export interface LinkingChannelConfig {
  baseUrl: string;
  /** How long to wait for connect + ack before giving up. Default 8s. */
  timeoutMs?: number;
}

export interface LinkingChannel {
  /**
   * Register a token + identity bundle. Resolves with the server-stamped
   * expiry ONLY after the server acknowledged it. Web must not render the
   * QR before this resolves (WEB-R1.2 common mistake).
   * Rejects with LinkingError (TOKEN_EXPIRED, TOKEN_ALREADY_USED,
   * INVALID_REGISTRATION, CHANNEL_UNREACHABLE, CHANNEL_TIMEOUT).
   */
  register(token: string, identity: LinkingIdentityBundle): Promise<{ expiresAt: Date }>;
  /** Pushed when the phone scans. Never poll for this. */
  onLinked(cb: (payload: LinkedPayload) => void): () => void;
  /** Pushed when the current token's 60s TTL elapses on the server. */
  onExpired(cb: (payload: LinkExpiredPayload) => void): () => void;
  close(): void;
}

export function createLinkingChannel(config: LinkingChannelConfig): LinkingChannel {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const socket: Socket = io(`${config.baseUrl}${LINKING_SOCKET_NAMESPACE}`, {
    path: SOCKET_PATH,
    transports: [SOCKET_TRANSPORT_PRIMARY, SOCKET_TRANSPORT_FALLBACK],
  });

  // Re-register the live token after a transient drop: the server keys the
  // entry by token, so this rejoins the room and replays any accountLinked
  // that was pushed while we were disconnected.
  let current: LinkingRegisterRequest | null = null;
  socket.io.on("reconnect", () => {
    if (current) socket.emit(LINKING_EVENTS.register, current, () => {});
  });

  function waitConnected(): Promise<void> {
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new LinkingError(CLIENT_ERRORS.unreachable));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        socket.off("connect", onConnect);
      }
      socket.on("connect", onConnect);
    });
  }

  return {
    async register(token, identity) {
      await waitConnected();
      const req: LinkingRegisterRequest = { token, ...identity };
      const ack = await new Promise<LinkingRegisterAck>((resolve, reject) => {
        socket
          .timeout(timeoutMs)
          .emit(LINKING_EVENTS.register, req, (err: Error | null, res: LinkingRegisterAck) => {
            if (err) reject(new LinkingError(CLIENT_ERRORS.timeout));
            else resolve(res);
          });
      });
      if (!ack.ok) throw new LinkingError(ack.error);
      current = req;
      return { expiresAt: new Date(ack.expiresAt) };
    },
    onLinked(cb) {
      const handler = (p: LinkedPayload) => {
        current = null;
        cb(p);
      };
      socket.on(LINKING_EVENTS.accountLinked, handler);
      return () => {
        socket.off(LINKING_EVENTS.accountLinked, handler);
      };
    },
    onExpired(cb) {
      socket.on(LINKING_EVENTS.linkExpired, cb);
      return () => {
        socket.off(LINKING_EVENTS.linkExpired, cb);
      };
    },
    close() {
      current = null;
      socket.close();
    },
  };
}

// ── HTTP: scan / logoff / refresh / relay ──────────────────────────────

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  accessToken?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/${API_VERSION}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new LinkingError(CLIENT_ERRORS.unreachable);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new LinkingError(json.error ?? `HTTP_${res.status}`, res.status);
  return json as T;
}

export interface WebSessionApiConfig {
  baseUrl: string;
}

export function createWebSessionApi(config: WebSessionApiConfig) {
  const { baseUrl } = config;
  return {
    /** PHONE side: confirm a scanned QR. Used by the phone app and by tests. */
    scan: (phoneAccessToken: string, token: string) =>
      postJson<LinkingScanResponse>(baseUrl, LINKING_API.scan, { token }, phoneAccessToken),

    /** Web logs itself off. Afterwards its refresh token is rejected. */
    logoff: (accessToken: string) =>
      postJson<LinkingLogoffResponse>(baseUrl, LINKING_API.logoff, {}, accessToken),

    /** Rotating refresh: persist the returned refreshToken, drop the old one. */
    refresh: (refreshToken: string) =>
      postJson<RefreshResponse>(baseUrl, LINKING_API.refresh, { refreshToken }),

    /** Relay send: queued server-side; never depends on the phone being online. */
    relaySend: (accessToken: string, body: RelaySendRequest) =>
      postJson<{ count: number }>(baseUrl, "/relay/send", body, accessToken),

    /** Every undelivered envelope for this device (used after `queue_more`). */
    relayPoll: (accessToken: string) =>
      postJson<RelayPollResponse>(baseUrl, "/relay/poll", {}, accessToken),
  };
}

export type WebSessionApi = ReturnType<typeof createWebSessionApi>;

// ── Session channel ────────────────────────────────────────────────────

export interface SessionChannelConfig {
  baseUrl: string;
  userId: string;
  deviceId: string;
  getAccessToken: () => string | null | Promise<string | null>;
}

export interface SessionChannel {
  /** Session revoked elsewhere (new phone login / re-link). Drop credentials. */
  onForceLogout(cb: () => void): () => void;
  /** Phone reachability. Informational: must never block Web (WEB-R1.4). */
  onPhonePresence(cb: (p: PhonePresencePayload) => void): () => void;
  /** The server refused the handshake (revoked / invalid token). */
  onAuthError(cb: (message: string) => void): () => void;
  /** A relayed envelope: live, or drained after a reconnect. */
  onMessage(cb: (m: RelayMessage) => void): () => void;
  /** The reconnect drain was capped; fetch the rest via relayPoll. */
  onQueueMore(cb: () => void): () => void;
  readonly socket: Socket;
  close(): void;
}

export function createSessionChannel(config: SessionChannelConfig): SessionChannel {
  const socket = createRealtimeClient({
    baseUrl: config.baseUrl,
    userId: config.userId,
    deviceId: config.deviceId,
    getAuthToken: config.getAccessToken,
  });
  return {
    socket,
    onForceLogout(cb) {
      socket.on(SESSION_EVENTS.forceLogout, cb);
      return () => {
        socket.off(SESSION_EVENTS.forceLogout, cb);
      };
    },
    onPhonePresence(cb) {
      socket.on(SESSION_EVENTS.phonePresence, cb);
      return () => {
        socket.off(SESSION_EVENTS.phonePresence, cb);
      };
    },
    onAuthError(cb) {
      const handler = (err: Error) => cb(err.message);
      socket.on("connect_error", handler);
      return () => {
        socket.off("connect_error", handler);
      };
    },
    onMessage(cb) {
      socket.on(SESSION_EVENTS.message, cb);
      return () => {
        socket.off(SESSION_EVENTS.message, cb);
      };
    },
    onQueueMore(cb) {
      socket.on(SESSION_EVENTS.queueMore, cb);
      return () => {
        socket.off(SESSION_EVENTS.queueMore, cb);
      };
    },
    close() {
      socket.close();
    },
  };
}

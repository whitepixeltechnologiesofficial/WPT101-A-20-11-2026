/**
 * WEB-R1.0 — Mock of the Web-linking backend (stands in for BE-6.1).
 *
 * Serves EXACTLY the wire contract in @wpt/shared (linking.ts), the same one
 * apps/backend serves, so Web needs no code change to switch between them:
 * set API_BASE_URL to this server or to the real backend.
 *
 * Protocol surface (identical to BE-6.1):
 *   socket.io path /realtime
 *     /linking  register(token, identity) → ack { ok, expiresAt }   (60s TTL, single use)
 *               push accountLinked, linkExpired
 *     /         JWT-style auth { token, userId, deviceId }
 *               push force_logout, phone_presence
 *   POST /api/v1/linking/scan       (phone)  distinct 410 codes: TOKEN_EXPIRED / TOKEN_ALREADY_USED / TOKEN_UNKNOWN
 *   POST /api/v1/linking/logoff     (web)
 *   POST /api/v1/onboarding/refresh (rotating, reuse revokes the family)
 *   POST /api/v1/relay/send         (queued; independent of phone presence)
 *
 * Dev-only triggers (NOT protocol; BE-6.1 does not implement them):
 *   GET  /__mock                 control panel (scan / phone offline / force logout buttons)
 *   GET  /__mock/state
 *   POST /__mock/scan            { token? }   simulate the phone scanning (newest QR if no token)
 *   POST /__mock/force-logout                 simulate a new-phone login (§7.3)
 *   POST /__mock/phone-presence  { online }   phone goes offline / online
 *
 * State is in memory. No users are hard-coded beyond the single mock phone
 * account that "scans"; there is no fake chat data.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server as SocketServer, type Socket } from "socket.io";
import {
  API_VERSION,
  LINKING_API,
  LINKING_EVENTS,
  LINKING_SOCKET_NAMESPACE,
  LINKING_TOKEN_PATTERN,
  LINKING_TOKEN_TTL_MS,
  SESSION_EVENTS,
  SOCKET_PATH,
  type LinkedPayload,
  type LinkingIdentityBundle,
  type LinkingRegisterAck,
  type LinkingRegisterRequest,
  type LinkingScanError,
  type PhonePresencePayload,
} from "@wpt/shared";

export interface MockServerOptions {
  port?: number;
  /** Override the 60s TTL. Tests only; the contract value is LINKING_TOKEN_TTL_MS. */
  ttlMs?: number;
  log?: boolean;
}

export interface MockServer {
  url: string;
  close(): Promise<void>;
  /** In-process triggers (same as the /__mock HTTP routes) for tests. */
  controls: {
    scan(token?: string): Promise<{ status: number; body: unknown }>;
    forceLogout(): void;
    setPhoneOnline(online: boolean): void;
    /** The phone account's current access token (for calling /linking/scan directly). */
    phoneAccessToken(): string;
    queuedMessages(): ReadonlyArray<{ clientMessageId: string; deviceId: string; ciphertext: string }>;
  };
}

type Tombstone = "expired" | "used";

interface LinkEntry {
  createdAt: number;
  identity: LinkingIdentityBundle;
  locked: boolean;
  delivered: LinkedPayload | null;
}

interface Session {
  id: string;
  userId: string;
  deviceId: string;
  familyId: string;
  revoked: boolean;
}

interface Device {
  id: string;
  userId: string;
  type: "phone" | "web";
  revoked: boolean;
  identity?: LinkingIdentityBundle;
}

const MOCK_USER_ID = "mock-user-0001";

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const ttlMs = opts.ttlMs ?? LINKING_TOKEN_TTL_MS;
  const log = (...a: unknown[]) => opts.log && console.log("[mock]", ...a);

  // ── state ──
  const links = new Map<string, LinkEntry>();
  const tombstones = new Map<string, Tombstone>();
  const sessions = new Map<string, Session>();
  const accessTokens = new Map<string, string>(); // token -> sessionId
  const refreshTokens = new Map<string, { sessionId: string; rotated: boolean }>();
  const devices = new Map<string, Device>();
  const queued: Array<{ clientMessageId: string; deviceId: string; ciphertext: string }> = [];
  let phoneOnline = true;

  const opaque = (p: string) => `${p}_${randomBytes(24).toString("base64url")}`;

  function issueSession(userId: string, deviceId: string, familyId: string = randomUUID()) {
    const s: Session = { id: randomUUID(), userId, deviceId, familyId, revoked: false };
    sessions.set(s.id, s);
    const accessToken = opaque("mat");
    const refreshToken = opaque("mrt");
    accessTokens.set(accessToken, s.id);
    refreshTokens.set(refreshToken, { sessionId: s.id, rotated: false });
    return { session: s, accessToken, refreshToken };
  }

  // The single mock phone account (the "scanner").
  const phoneDevice: Device = { id: randomUUID(), userId: MOCK_USER_ID, type: "phone", revoked: false };
  devices.set(phoneDevice.id, phoneDevice);
  let phoneAccess = issueSession(MOCK_USER_ID, phoneDevice.id).accessToken;

  function authSession(token: string | undefined | null): Session | null {
    if (!token) return null;
    const sid = accessTokens.get(token);
    const s = sid ? sessions.get(sid) : undefined;
    return s && !s.revoked ? s : null;
  }

  // ── http ──
  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error("[mock] handler error", err);
      send(res, 500, { error: "MOCK_ERROR" });
    });
  });

  const io = new SocketServer(httpServer, { path: SOCKET_PATH, cors: { origin: true } });
  const linkingNs = io.of(LINKING_SOCKET_NAMESPACE);

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
    res.writeHead(status, {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  const bearer = (req: IncomingMessage) => req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
  const api = (p: string) => `/api/${API_VERSION}${p}`;

  function isExpired(e: LinkEntry, now = Date.now()) {
    return now - e.createdAt > ttlMs;
  }

  /** Shared by /linking/scan and the /__mock/scan trigger. */
  function doScan(token: unknown, userId: string): { status: number; body: unknown } {
    const fail = (status: number, error: LinkingScanError) => ({ status, body: { error } });
    if (typeof token !== "string" || !LINKING_TOKEN_PATTERN.test(token)) return fail(400, "INVALID_TOKEN");

    const tomb = tombstones.get(token);
    if (tomb === "expired") return fail(410, "TOKEN_EXPIRED");
    if (tomb === "used") return fail(410, "TOKEN_ALREADY_USED");
    const entry = links.get(token);
    if (!entry) return fail(410, "TOKEN_UNKNOWN");
    if (isExpired(entry)) {
      expire(token);
      return fail(410, "TOKEN_EXPIRED");
    }
    if (entry.locked) return fail(410, "TOKEN_ALREADY_USED");
    entry.locked = true;

    // One Web session per account: revoke the previous browser (never the phone).
    for (const d of devices.values()) {
      if (d.userId === userId && d.type === "web" && !d.revoked) {
        d.revoked = true;
        for (const s of sessions.values()) if (s.deviceId === d.id) s.revoked = true;
        io.to(`device:${d.id}`).emit(SESSION_EVENTS.forceLogout);
        io.in(`device:${d.id}`).disconnectSockets(true);
      }
    }

    const web: Device = { id: randomUUID(), userId, type: "web", revoked: false, identity: entry.identity };
    devices.set(web.id, web);
    const issued = issueSession(userId, web.id);
    const payload: LinkedPayload = {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      userId,
      deviceId: web.id,
      sessionId: issued.session.id,
    };
    entry.delivered = payload;
    tombstones.set(token, "used");
    // PUSH down the same channel Web registered on. Web never polls.
    linkingNs.to(`link:${token}`).emit(LINKING_EVENTS.accountLinked, payload);
    log("linked web device", web.id);
    return { status: 200, body: { ok: true, linked: true, deviceId: web.id } };
  }

  function expire(token: string) {
    links.delete(token);
    if (!tombstones.has(token)) tombstones.set(token, "expired");
    linkingNs.to(`link:${token}`).emit(LINKING_EVENTS.linkExpired, { reason: "ttl" });
  }

  function forceLogout() {
    // §7.3 new-phone login: every existing session for the account is revoked.
    for (const s of sessions.values()) if (s.userId === MOCK_USER_ID) s.revoked = true;
    for (const d of devices.values()) if (d.userId === MOCK_USER_ID && d.type === "web") d.revoked = true;
    io.to(`user:${MOCK_USER_ID}`).emit(SESSION_EVENTS.forceLogout);
    io.in(`user:${MOCK_USER_ID}`).disconnectSockets(true);
    // The new phone gets a fresh session.
    phoneAccess = issueSession(MOCK_USER_ID, phoneDevice.id).accessToken;
    log("force_logout pushed");
  }

  function setPhoneOnline(online: boolean) {
    phoneOnline = online;
    const p: PhonePresencePayload = { online, at: new Date().toISOString() };
    io.to(`user:${MOCK_USER_ID}`).emit(SESSION_EVENTS.phonePresence, p);
    log("phone", online ? "online" : "offline");
  }

  function newestPendingToken(): string | undefined {
    let best: [string, LinkEntry] | undefined;
    for (const e of links) if (!e[1].locked && !isExpired(e[1]) && (!best || e[1].createdAt > best[1].createdAt)) best = e;
    return best?.[0];
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock");
    if (req.method === "OPTIONS") return send(res, 204, "");

    if (req.method === "GET" && url.pathname === "/__mock") return send(res, 200, PANEL_HTML, "text/html");
    if (req.method === "GET" && url.pathname === "/__mock/state") {
      const now = Date.now();
      return send(res, 200, {
        phoneOnline,
        pendingTokens: [...links]
          .filter(([, e]) => !e.locked && !isExpired(e, now))
          .map(([t, e]) => ({ token: t, expiresInMs: ttlMs - (now - e.createdAt) })),
        activeWebDevices: [...devices.values()].filter((d) => d.type === "web" && !d.revoked).map((d) => d.id),
        queuedMessages: queued.length,
      });
    }
    if (req.method !== "POST") return send(res, 404, { error: "NOT_FOUND" });

    const body = await readJson(req);
    switch (url.pathname) {
      case api(LINKING_API.scan): {
        const s = authSession(bearer(req));
        if (!s) return send(res, 401, { error: "INVALID_TOKEN" });
        const r = doScan(body.token, s.userId);
        return send(res, r.status, r.body);
      }
      case api(LINKING_API.logoff): {
        const s = authSession(bearer(req));
        if (!s) return send(res, 401, { error: "INVALID_TOKEN" });
        const d = devices.get(s.deviceId);
        if (!d) return send(res, 404, { error: "DEVICE_NOT_FOUND" });
        if (d.type !== "web") return send(res, 403, { error: "NOT_A_WEB_SESSION" });
        d.revoked = true;
        s.revoked = true;
        io.in(`device:${d.id}`).disconnectSockets(true);
        return send(res, 200, { ok: true });
      }
      case api(LINKING_API.refresh): {
        const presented = typeof body.refreshToken === "string" ? body.refreshToken : "";
        if (!presented) return send(res, 400, { error: "refreshToken is required" });
        const rt = refreshTokens.get(presented);
        const s = rt ? sessions.get(rt.sessionId) : undefined;
        if (!rt || !s) return send(res, 401, { error: "INVALID_REFRESH_TOKEN" });
        if (rt.rotated) {
          for (const x of sessions.values()) if (x.familyId === s.familyId) x.revoked = true;
          return send(res, 401, { error: "REFRESH_TOKEN_REUSE" });
        }
        if (s.revoked) return send(res, 401, { error: "INVALID_REFRESH_TOKEN" });
        rt.rotated = true;
        s.revoked = true;
        const next = issueSession(s.userId, s.deviceId, s.familyId);
        return send(res, 200, { accessToken: next.accessToken, refreshToken: next.refreshToken });
      }
      case api("/relay/send"): {
        const s = authSession(bearer(req));
        if (!s) return send(res, 401, { error: "INVALID_TOKEN" });
        const recipients = Array.isArray(body.recipients) ? (body.recipients as Array<Record<string, unknown>>) : [];
        if (typeof body.clientMessageId !== "string" || recipients.length === 0) {
          return send(res, 400, { error: "INVALID_REQUEST" });
        }
        // Deliberately NOT gated on phoneOnline: Web is its own device (WEB-R1.4).
        for (const r of recipients) {
          queued.push({
            clientMessageId: body.clientMessageId,
            deviceId: String(r.deviceId),
            ciphertext: String(r.ciphertext),
          });
        }
        return send(res, 200, { count: recipients.length });
      }
      case "/__mock/scan": {
        const token = typeof body.token === "string" ? body.token : newestPendingToken();
        if (!token) return send(res, 404, { error: "NO_PENDING_QR" });
        const r = doScan(token, MOCK_USER_ID);
        return send(res, r.status, r.body);
      }
      case "/__mock/force-logout":
        forceLogout();
        return send(res, 200, { ok: true });
      case "/__mock/phone-presence":
        setPhoneOnline(body.online === true);
        return send(res, 200, { ok: true, online: phoneOnline });
      default:
        return send(res, 404, { error: "NOT_FOUND" });
    }
  }

  // ── /linking namespace (no auth: Web has no credentials yet) ──
  linkingNs.on("connection", (socket: Socket) => {
    socket.on(
      LINKING_EVENTS.register,
      (data: Partial<LinkingRegisterRequest> | undefined, ack?: (r: LinkingRegisterAck) => void) => {
        const reply = (r: LinkingRegisterAck) => ack?.(r);
        const token = data?.token;
        if (typeof token !== "string" || !LINKING_TOKEN_PATTERN.test(token) || !data?.identityPublicKey) {
          return reply({ ok: false, error: "INVALID_REGISTRATION" });
        }
        let entry = links.get(token);
        if (entry && isExpired(entry)) {
          expire(token);
          entry = undefined;
        }
        // Single use: an expired or consumed token can never come back.
        const tomb = tombstones.get(token);
        if (!entry && tomb) return reply({ ok: false, error: tomb === "used" ? "TOKEN_ALREADY_USED" : "TOKEN_EXPIRED" });

        if (!entry) {
          entry = {
            createdAt: Date.now(), // server-stamped; never trusted from the client
            identity: { identityPublicKey: data.identityPublicKey, signingPublicKey: data.signingPublicKey },
            locked: false,
            delivered: null,
          };
          links.set(token, entry);
        } else if (entry.identity.identityPublicKey !== data.identityPublicKey) {
          // The token is visible to anyone who can see the screen; the identity
          // key is not. Only the browser that registered it may rejoin (and get
          // a replayed accountLinked), otherwise a photographed QR could
          // receive the Web credentials.
          return reply({ ok: false, error: "TOKEN_ALREADY_USED" });
        }
        void socket.join(`link:${token}`);
        reply({ ok: true, expiresAt: new Date(entry.createdAt + ttlMs).toISOString() });
        // Reconnect within TTL after the scan already happened: replay the push.
        if (entry.delivered) socket.emit(LINKING_EVENTS.accountLinked, entry.delivered);
      },
    );
  });

  // ── default namespace (authenticated session channel) ──
  io.use((socket, next) => {
    const { token, userId, deviceId } = (socket.handshake.auth ?? {}) as Record<string, string | undefined>;
    if (!token || !userId || !deviceId) return next(new Error("Authentication required"));
    const sid = accessTokens.get(token);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) return next(new Error("Invalid token"));
    if (s.revoked) return next(new Error("Session revoked"));
    if (s.userId !== userId || s.deviceId !== deviceId) return next(new Error("Token userId mismatch"));
    next();
  });
  io.on("connection", (socket) => {
    const { userId, deviceId } = socket.handshake.auth as { userId: string; deviceId: string };
    void socket.join([`user:${userId}`, `device:${deviceId}`]);
    socket.emit(SESSION_EVENTS.phonePresence, { online: phoneOnline, at: new Date().toISOString() });
  });

  // TTL sweep: tell a still-connected Web its QR died so it regenerates.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [t, e] of links) if (isExpired(e, now)) expire(t);
  }, Math.min(1_000, ttlMs / 4));
  sweep.unref();

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  log(`listening on ${url}  (control panel: ${url}/__mock)`);

  return {
    url,
    async close() {
      clearInterval(sweep);
      await new Promise<void>((r) => io.close(() => r()));
    },
    controls: {
      scan: async (token?: string) => {
        const t = token ?? newestPendingToken();
        return t ? doScan(t, MOCK_USER_ID) : { status: 404, body: { error: "NO_PENDING_QR" } };
      },
      forceLogout,
      setPhoneOnline,
      phoneAccessToken: () => phoneAccess,
      queuedMessages: () => queued,
    },
  };
}

const PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WPT linking mock</title>
<style>body{font:15px system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1b1f24}
button{font:inherit;padding:8px 14px;margin:4px 6px 4px 0;border-radius:6px;border:1px solid #888;background:#f4f4f4;cursor:pointer}
code{font-size:12px;word-break:break-all}li{margin:6px 0}.muted{color:#666}</style></head><body>
<h1>WPT linking mock</h1><p class="muted">Dev-only triggers for WEB-R1.0. Acts as the paired phone.</p>
<h2>Pending QR tokens</h2><ul id="tokens"><li class="muted">none</li></ul>
<h2>Phone</h2><p>Status: <b id="phone">?</b></p>
<button onclick="post('/__mock/phone-presence',{online:false})">Phone offline</button>
<button onclick="post('/__mock/phone-presence',{online:true})">Phone online</button>
<button onclick="post('/__mock/force-logout',{})">New-phone login (force_logout)</button>
<p id="out" class="muted"></p>
<script>
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
document.getElementById('out').textContent=p+' -> '+r.status+' '+await r.text();refresh();}
let shown='';
async function refresh(){const s=await (await fetch('/__mock/state')).json();
document.getElementById('phone').textContent=s.phoneOnline?'online':'offline';
const ul=document.getElementById('tokens');const key=s.pendingTokens.map(t=>t.token).join();
if(key!==shown){shown=key;ul.innerHTML='';
if(!s.pendingTokens.length)ul.innerHTML='<li class="muted">none</li>';
for(const t of s.pendingTokens){const li=document.createElement('li');li.dataset.token=t.token;
li.innerHTML='<code>'+t.token+'</code> <span class="muted ttl"></span> ';
const b=document.createElement('button');b.textContent='Scan';b.onclick=()=>post('/__mock/scan',{token:t.token});li.appendChild(b);ul.appendChild(li);}}
for(const t of s.pendingTokens){const li=ul.querySelector('[data-token="'+t.token+'"] .ttl');if(li)li.textContent='('+Math.ceil(t.expiresInMs/1000)+'s)';}}
refresh();setInterval(refresh,1000);
</script></body></html>`;

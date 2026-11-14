/**
 * WEB-R1.0 VERIFY: each of the five mock behaviours can be triggered from a
 * test, exercised ONLY through the public @wpt/api-client functions Web uses.
 *
 *   (1) linking channel: register, 60s TTL, expired / reused tokens rejected
 *   (2) simulated scan PUSHES access + refresh tokens down the same channel
 *   (3) log-off revokes the session; the old refresh token is rejected
 *   (4) force_logout push (new-phone login)
 *   (5) phone offline / online events; Web keeps working throughout
 *
 * The TTL is shortened to 1.5s here so the suite runs quickly; the mock's
 * production value is LINKING_TOKEN_TTL_MS (60s).
 *
 * Run: pnpm --filter @wpt/api-client test
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LINKING_TOKEN_PATTERN, type LinkedPayload, type PhonePresencePayload } from "@wpt/shared";
import {
  LinkingError,
  createLinkingChannel,
  createLinkingToken,
  createSessionChannel,
  createWebSessionApi,
  type LinkingChannel,
} from "../src/index.js";
import { startMockServer, type MockServer } from "../mock/server.js";

const TTL = 1_500;
const identity = { identityPublicKey: "aWRlbnRpdHk=", signingPublicKey: "c2lnbmluZw==" };

let mock: MockServer;
let api: ReturnType<typeof createWebSessionApi>;
const channels: LinkingChannel[] = [];
const closers: Array<() => void> = [];

function channel() {
  const c = createLinkingChannel({ baseUrl: mock.url, timeoutMs: 3_000 });
  channels.push(c);
  return c;
}

function nextEvent<T>(subscribe: (cb: (v: T) => void) => () => void, ms = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for push"));
    }, ms);
    const off = subscribe((v) => {
      clearTimeout(timer);
      off();
      resolve(v);
    });
  });
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof LinkingError && e.code === code);
}

/** Register + simulated scan → linked Web credentials. */
async function linkWeb(): Promise<LinkedPayload> {
  const ch = channel();
  const token = createLinkingToken();
  await ch.register(token, identity);
  const pushed = nextEvent<LinkedPayload>((cb) => ch.onLinked(cb));
  await mock.controls.scan(token);
  return pushed;
}

function sessionChannel(p: LinkedPayload, getToken: () => string = () => p.accessToken) {
  const s = createSessionChannel({
    baseUrl: mock.url,
    userId: p.userId,
    deviceId: p.deviceId,
    getAccessToken: getToken,
  });
  closers.push(() => s.close());
  return s;
}

before(async () => {
  mock = await startMockServer({ ttlMs: TTL });
  api = createWebSessionApi({ baseUrl: mock.url });
});

after(async () => {
  channels.forEach((c) => c.close());
  closers.forEach((c) => c());
  await mock.close();
});

describe("WEB-R1.2 token", () => {
  it("is CSPRNG base64url, matches the contract pattern, never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = createLinkingToken();
      assert.match(t, LINKING_TOKEN_PATTERN);
      assert.equal(t.length, 43);
      seen.add(t);
    }
    assert.equal(seen.size, 500);
  });
});

describe("(1) linking channel", () => {
  it("acks a registration with a server-stamped expiry ~TTL ahead", async () => {
    const before = Date.now();
    const { expiresAt } = await channel().register(createLinkingToken(), identity);
    const delta = expiresAt.getTime() - before;
    assert.ok(delta > TTL - 500 && delta <= TTL + 500, `expiry ${delta}ms`);
  });

  it("rejects a malformed registration", async () => {
    await rejectsWith(channel().register("short", identity), "INVALID_REGISTRATION");
    await rejectsWith(channel().register(createLinkingToken(), { identityPublicKey: "" }), "INVALID_REGISTRATION");
  });

  it("pushes linkExpired after the TTL, then rejects that token everywhere with TOKEN_EXPIRED", async () => {
    const ch = channel();
    const token = createLinkingToken();
    await ch.register(token, identity);
    const expired = await nextEvent((cb) => ch.onExpired(cb), TTL + 3_000);
    assert.deepEqual(expired, { reason: "ttl" });

    // Edge case: phone scans just after expiry → a clear "expired", not a generic error.
    await rejectsWith(api.scan(mock.controls.phoneAccessToken(), token), "TOKEN_EXPIRED");
    // And the token can never be re-registered to extend its life.
    await rejectsWith(channel().register(token, identity), "TOKEN_EXPIRED");
  });

  it("rejects a reused token after it linked (TOKEN_ALREADY_USED)", async () => {
    const ch = channel();
    const token = createLinkingToken();
    await ch.register(token, identity);
    const pushed = nextEvent<LinkedPayload>((cb) => ch.onLinked(cb));
    assert.equal((await mock.controls.scan(token)).status, 200);
    await pushed;
    await rejectsWith(api.scan(mock.controls.phoneAccessToken(), token), "TOKEN_ALREADY_USED");
    // Someone else who saw the QR cannot claim it, before or after the scan.
    await rejectsWith(channel().register(token, { identityPublicKey: "b3RoZXI=" }), "TOKEN_ALREADY_USED");
  });

  it("a different browser cannot hijack a pending token", async () => {
    const token = createLinkingToken();
    await channel().register(token, identity);
    await rejectsWith(channel().register(token, { identityPublicKey: "YXR0YWNrZXI=" }), "TOKEN_ALREADY_USED");
  });

  it("the SAME browser reconnecting after the scan gets the push replayed", async () => {
    const ch = channel();
    const token = createLinkingToken();
    await ch.register(token, identity);
    await mock.controls.scan(token);
    const again = channel();
    const replayed = nextEvent<LinkedPayload>((cb) => again.onLinked(cb));
    await again.register(token, identity);
    assert.ok((await replayed).accessToken);
  });

  it("distinguishes unknown and malformed tokens on scan", async () => {
    await rejectsWith(api.scan(mock.controls.phoneAccessToken(), createLinkingToken()), "TOKEN_UNKNOWN");
    await rejectsWith(api.scan(mock.controls.phoneAccessToken(), "nope"), "INVALID_TOKEN");
  });

  it("reports an unreachable channel as CHANNEL_UNREACHABLE (Web shows retry)", async () => {
    const dead = createLinkingChannel({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 });
    channels.push(dead);
    await rejectsWith(dead.register(createLinkingToken(), identity), "CHANNEL_UNREACHABLE");
  });
});

describe("(2) simulated scan pushes credentials", () => {
  it("pushes accessToken + refreshToken down the SAME channel (no polling)", async () => {
    const ch = channel();
    const token = createLinkingToken();
    await ch.register(token, identity);
    const pushed = nextEvent<LinkedPayload>((cb) => ch.onLinked(cb));
    // The phone's real HTTP scan call, as BE-6.1 serves it.
    const res = await api.scan(mock.controls.phoneAccessToken(), token);
    const p = await pushed;
    assert.equal(res.linked, true);
    assert.equal(p.deviceId, res.deviceId);
    for (const k of ["accessToken", "refreshToken", "userId", "deviceId", "sessionId"] as const) {
      assert.ok(typeof p[k] === "string" && p[k].length > 0, k);
    }
  });

  it("pushed credentials open the authenticated session channel", async () => {
    const p = await linkWeb();
    const s = sessionChannel(p);
    await nextEvent<void>((cb) => {
      s.socket.on("connect", cb);
      return () => s.socket.off("connect", cb);
    });
    assert.ok(s.socket.connected);
  });
});

describe("(3) log-off", () => {
  it("revokes the session; the old refresh token is rejected afterwards", async () => {
    const p = await linkWeb();
    const rotated = await api.refresh(p.refreshToken); // rotation works while linked
    await api.logoff(rotated.accessToken);
    await rejectsWith(api.refresh(rotated.refreshToken), "INVALID_REFRESH_TOKEN");
    await rejectsWith(api.logoff(rotated.accessToken), "INVALID_TOKEN");
  });

  it("refresh is rotating: presenting a superseded token is reuse and revokes the family", async () => {
    const p = await linkWeb();
    const next = await api.refresh(p.refreshToken);
    await rejectsWith(api.refresh(p.refreshToken), "REFRESH_TOKEN_REUSE");
    await rejectsWith(api.refresh(next.refreshToken), "INVALID_REFRESH_TOKEN");
  });
});

describe("(4) force_logout", () => {
  it("pushes force_logout to the linked Web session and revokes it", async () => {
    const p = await linkWeb();
    const s = sessionChannel(p);
    await nextEvent<void>((cb) => {
      s.socket.on("connect", cb);
      return () => s.socket.off("connect", cb);
    });
    const kicked = nextEvent<void>((cb) => s.onForceLogout(cb));
    mock.controls.forceLogout();
    await kicked;
    await rejectsWith(api.refresh(p.refreshToken), "INVALID_REFRESH_TOKEN");
  });

  it("re-linking a new browser force-logs-out the previous one", async () => {
    const first = await linkWeb();
    const s = sessionChannel(first);
    await nextEvent<void>((cb) => {
      s.socket.on("connect", cb);
      return () => s.socket.off("connect", cb);
    });
    const kicked = nextEvent<void>((cb) => s.onForceLogout(cb));
    await linkWeb();
    await kicked;
  });
});

describe("(5) phone offline / online", () => {
  it("pushes presence changes while Web keeps working (relay send + refresh)", async () => {
    let p = await linkWeb();
    const s = sessionChannel(p, () => p.accessToken);
    // On connect the server reports current presence.
    await nextEvent<PhonePresencePayload>((cb) => s.onPhonePresence(cb));

    const offline = nextEvent<PhonePresencePayload>((cb) => s.onPhonePresence(cb));
    mock.controls.setPhoneOnline(false);
    assert.equal((await offline).online, false);

    // Phone is offline: Web still sends (queued by the backend relay) ...
    const before = mock.controls.queuedMessages().length;
    const sent = await api.relaySend(p.accessToken, {
      clientMessageId: crypto.randomUUID(),
      recipients: [{ deviceId: "some-device", ciphertext: "abcd" }],
    });
    assert.equal(sent.count, 1);
    assert.equal(mock.controls.queuedMessages().length, before + 1);
    // ... still refreshes its own session ...
    const r = await api.refresh(p.refreshToken);
    p = { ...p, ...r };
    // ... and its socket was never dropped.
    assert.ok(s.socket.connected);

    const online = nextEvent<PhonePresencePayload>((cb) => s.onPhonePresence(cb));
    mock.controls.setPhoneOnline(true);
    assert.equal((await online).online, true);
  });
});

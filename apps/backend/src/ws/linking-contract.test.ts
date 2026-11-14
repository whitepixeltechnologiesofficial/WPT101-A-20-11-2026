/**
 * BE-6.1 ⇄ WEB-R1.0 contract check: drives the REAL backend's /linking
 * channel with the same @wpt/api-client code Web uses against the mock.
 * If this passes, pointing API_BASE_URL at the backend needs no Web change.
 *
 * Covers the database-free half of the protocol (registration, ack shape,
 * single use, anti-hijack, distinct scan errors). The scan → push half
 * needs Postgres and is covered by the e2e suites.
 *
 * Run: pnpm --filter @wpt/backend exec tsx --test src/ws/linking-contract.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { LINKING_TOKEN_TTL_MS } from "@wpt/shared";
import { LinkingError, createLinkingChannel, createLinkingToken, type LinkingChannel } from "@wpt/api-client";
import { tryConsumeLinkingToken, rollbackLinkingConsumption } from "./linking-registry.js";

process.env.JWT_SECRET ??= "contract-test-secret-at-least-32-characters-long";

let baseUrl: string;
let close: () => Promise<void>;
const channels: LinkingChannel[] = [];
const identity = { identityPublicKey: "aWRlbnRpdHk=", signingPublicKey: "c2lnbmluZw==" };

function channel() {
  const c = createLinkingChannel({ baseUrl, timeoutMs: 3_000 });
  channels.push(c);
  return c;
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof LinkingError && e.code === code);
}

before(async () => {
  const { createApp } = await import("../app.js");
  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});

after(async () => {
  channels.forEach((c) => c.close());
  await close();
});

describe("BE-6.1 linking channel matches the WEB-R1.0 contract", () => {
  it("acks registration with a server-stamped expiresAt 60s ahead", async () => {
    const before = Date.now();
    const { expiresAt } = await channel().register(createLinkingToken(), identity);
    const delta = expiresAt.getTime() - before;
    assert.ok(Math.abs(delta - LINKING_TOKEN_TTL_MS) < 2_000, `expiry ${delta}ms`);
  });

  it("rejects malformed registrations", async () => {
    await rejectsWith(channel().register("short", identity), "INVALID_REGISTRATION");
  });

  it("refuses a second browser registering a pending token (anti-hijack)", async () => {
    const token = createLinkingToken();
    await channel().register(token, identity);
    await rejectsWith(channel().register(token, { identityPublicKey: "YXR0YWNrZXI=" }), "TOKEN_ALREADY_USED");
  });

  it("lets the same browser rejoin its token", async () => {
    const token = createLinkingToken();
    await channel().register(token, identity);
    await channel().register(token, identity);
  });

  it("returns distinct scan-side reasons: unknown, in-flight", () => {
    assert.deepEqual(tryConsumeLinkingToken(createLinkingToken()), { error: "TOKEN_UNKNOWN" });
  });

  it("locks a token during a scan and unlocks it on rollback", async () => {
    const token = createLinkingToken();
    await channel().register(token, identity);
    assert.ok("entry" in tryConsumeLinkingToken(token));
    assert.deepEqual(tryConsumeLinkingToken(token), { error: "TOKEN_ALREADY_USED" });
    rollbackLinkingConsumption(token);
    assert.ok("entry" in tryConsumeLinkingToken(token));
  });
});

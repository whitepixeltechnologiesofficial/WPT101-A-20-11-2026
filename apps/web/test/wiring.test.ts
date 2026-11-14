/**
 * WEB-R1.1 VERIFY: the workspace packages Web depends on actually RESOLVE
 * and work from apps/web, not merely "the dev server boots".
 *
 * Run: pnpm --filter web test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateIdentityKeyPair, generateX25519KeyPair } from "@wpt/crypto";
import { createLinkingToken, createWebSessionApi, LinkingError } from "@wpt/api-client";
import { API_VERSION, LINKING_API, LINKING_TOKEN_PATTERN } from "@wpt/shared";

describe("apps/web workspace wiring", () => {
  it("@wpt/crypto resolves and generates key pairs", () => {
    assert.equal(generateX25519KeyPair().publicKey.length, 32);
    assert.equal(generateIdentityKeyPair().publicKey.length, 32);
  });

  it("@wpt/api-client resolves and produces contract-valid tokens", () => {
    assert.match(createLinkingToken(), LINKING_TOKEN_PATTERN);
    assert.equal(typeof createWebSessionApi({ baseUrl: "http://x" }).scan, "function");
    assert.ok(new LinkingError("TOKEN_EXPIRED").isExpired);
  });

  it("@wpt/shared resolves", () => {
    assert.equal(API_VERSION, "v1");
    assert.equal(LINKING_API.scan, "/linking/scan");
  });
});

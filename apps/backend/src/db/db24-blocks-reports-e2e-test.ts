/**
 * DB-2.4 verification: blocks, reports, report_evidence (+ test mirrors).
 *
 * Starts the real Express app, creates two throwaway accounts (Alice, Bob),
 * and proves:
 *   [1] all five DB-2.4 tables exist (migration 020)
 *   [2] Alice blocks Bob through the REAL /blocks/block API
 *   [3] messaging is blocked in BOTH directions:
 *         Alice -> Bob  = 403   (blocker cannot message the blocked)
 *         Bob   -> Alice = 403  (blocked cannot message the blocker)
 *   [4] the block is keyed by phone_hash: deleting Bob's account and
 *       re-creating it on the same number keeps the block
 *   [5] unblock restores messaging in both directions
 *   [6] test_reports / test_report_evidence: evidence cap is the SMALLER of
 *       20 messages / 7 days, and test writes never touch real reports
 *
 * Every row it creates is deleted in `finally`.
 *
 * Run: pnpm --filter @wpt/backend exec tsx src/db/db24-blocks-reports-e2e-test.ts
 */

import "dotenv/config";
import { randomUUID, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool } from "./pool.js";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";
import { phoneHash } from "../utils/phone-hash.js";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`, detail !== undefined ? `\n        -> ${JSON.stringify(detail)}` : "");
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool({ connectionString: dbUrl });

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const blockHashes: string[] = [];
  const testReportIds: string[] = [];
  const realReportsBefore = await pool.query(`SELECT count(*)::int AS n FROM reports`);

  try {
    const { API_VERSION } = await import("@wpt/shared");
    const call = async (route: string, token: string, body: unknown) => {
      const res = await fetch(`${base}/${API_VERSION}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        /* empty body */
      }
      return { status: res.status, json };
    };

    const makeUser = async (phone = `+1${randomInt(2000000000, 2999999999)}`) => {
      const userId = randomUUID();
      await pool.query(`INSERT INTO users (id, phone_number, name) VALUES ($1, $2, $3)`, [
        userId,
        phone,
        `DB24 Test ${userId.slice(0, 8)}`,
      ]);
      userIds.push(userId);
      const deviceId = randomUUID();
      await pool.query(
        `INSERT INTO devices (id, user_id, device_type, platform, identity_public_key)
         VALUES ($1, $2, 'phone', 'android', $3)`,
        [deviceId, userId, `pf_${deviceId}`],
      );
      deviceIds.push(deviceId);
      const token = await issueAccessToken({ userId, deviceId, sessionId: randomUUID() });
      return { userId, phone, deviceId, token };
    };
    const send = (from: { token: string }, to: { deviceId: string }) =>
      call("/relay/send", from.token, {
        clientMessageId: randomUUID(),
        recipients: [{ deviceId: to.deviceId, ciphertext: "ab12" }],
      });

    console.log("\n[1] Tables exist (migration 020)");
    const t = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name IN ('blocks','reports','report_evidence','test_reports','test_report_evidence')`,
    );
    const have = new Set(t.rows.map((r) => r.table_name as string));
    for (const name of ["blocks", "reports", "report_evidence", "test_reports", "test_report_evidence"]) {
      check(`table ${name} exists`, have.has(name));
    }
    if (!have.has("test_reports") || !have.has("test_report_evidence")) {
      throw new Error("Apply migrations/020_db24_blocks_reports_test_tables.sql first.");
    }

    const alice = await makeUser();
    let bob = await makeUser();
    blockHashes.push(phoneHash(alice.phone), phoneHash(bob.phone));

    console.log("\n[2] Baseline: both directions deliver before any block");
    check("Alice -> Bob = 200", (await send(alice, bob)).status === 200);
    check("Bob -> Alice = 200", (await send(bob, alice)).status === 200);

    console.log("\n[3] Alice blocks Bob via POST /blocks/block");
    const b = await call("/blocks/block", alice.token, { blockedPhone: bob.phone });
    check("block accepted", b.status === 200, b);
    const row = await pool.query(
      `SELECT 1 FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`,
      [phoneHash(alice.phone), phoneHash(bob.phone)],
    );
    check("exactly one row stored, keyed by phone_hash (Alice -> Bob)", row.rowCount === 1);
    const s1 = await send(alice, bob);
    check("Alice (blocker) -> Bob = 403", s1.status === 403, s1);
    const s2 = await send(bob, alice);
    check("Bob (blocked) -> Alice = 403", s2.status === 403, s2);

    console.log("\n[4] Block survives Bob deleting + re-creating his account");
    await pool.query(
      `DELETE FROM pending_messages WHERE sender_device_id = $1 OR recipient_device_id = $1 OR recipient_user_id = $2`,
      [bob.deviceId, bob.userId],
    );
    await pool.query(`DELETE FROM devices WHERE user_id = $1`, [bob.userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [bob.userId]);
    bob = await makeUser(bob.phone);
    check("new Bob account -> Alice still 403", (await send(bob, alice)).status === 403);
    check("Alice -> new Bob account still 403", (await send(alice, bob)).status === 403);

    console.log("\n[5] Unblock restores both directions");
    const u = await call("/blocks/unblock", alice.token, { blockedPhone: bob.phone });
    check("unblock accepted", u.status === 200, u);
    check("Alice -> Bob = 200 again", (await send(alice, bob)).status === 200);
    check("Bob -> Alice = 200 again", (await send(bob, alice)).status === 200);

    console.log("\n[6] test_reports / test_report_evidence");
    const tr = await pool.query(
      `INSERT INTO test_reports (reporter_phone_hash, reported_phone_hash, reason_category)
       VALUES ($1, $2, 'harassment') RETURNING id, status, evidence_expires_at, created_at`,
      [phoneHash(alice.phone), phoneHash(bob.phone)],
    );
    const rep = tr.rows[0];
    testReportIds.push(rep.id);
    check("status defaults to 'pending'", rep.status === "pending");
    check(
      "evidence_expires_at = created_at + 30 days",
      new Date(rep.evidence_expires_at).getTime() - new Date(rep.created_at).getTime() === 30 * 86400_000,
    );

    // 7-day limit: a message from 8 days ago is rejected even though < 20 rows.
    let rejected8d = false;
    try {
      await pool.query(
        `INSERT INTO test_report_evidence (test_report_id, message_content, message_created_at)
         VALUES ($1, 'old', now() - interval '8 days')`,
        [rep.id],
      );
    } catch {
      rejected8d = true;
    }
    check("message older than 7 days rejected (7-day limit binds)", rejected8d);

    // 20-message limit: 25 recent messages -> only 20 stored.
    let stored = 0;
    for (let i = 0; i < 25; i++) {
      try {
        await pool.query(
          `INSERT INTO test_report_evidence (test_report_id, message_content, message_created_at)
           VALUES ($1, $2, now() - ($3 || ' minutes')::interval)`,
          [rep.id, `msg ${i}`, String(i)],
        );
        stored++;
      } catch {
        /* cap reached */
      }
    }
    check("25 recent messages -> 20 stored (20-message limit binds)", stored === 20, stored);
    const snap = await pool.query(
      `SELECT jsonb_array_length(decrypted_message_snapshot) AS n FROM test_reports WHERE id = $1`,
      [rep.id],
    );
    check("snapshot on test report holds 20 messages", snap.rows[0].n === 20, snap.rows[0]);

    const realReportsAfter = await pool.query(`SELECT count(*)::int AS n FROM reports`);
    check("real reports table untouched", realReportsAfter.rows[0].n === realReportsBefore.rows[0].n);
  } finally {
    if (testReportIds.length) await pool.query(`DELETE FROM test_reports WHERE id = ANY($1::uuid[])`, [testReportIds]);
    if (blockHashes.length) {
      await pool.query(
        `DELETE FROM blocks WHERE blocker_phone_hash = ANY($1::text[]) OR blocked_phone_hash = ANY($1::text[])`,
        [blockHashes],
      );
    }
    if (deviceIds.length) {
      await pool.query(
        `DELETE FROM pending_messages WHERE sender_device_id = ANY($1::uuid[]) OR recipient_device_id = ANY($1::uuid[])`,
        [deviceIds],
      );
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    await new Promise<void>((r) => io.close(() => r()));
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

-- ============================================================
-- 022_pending_messages_drain_index.sql
-- WEB-R1.5: invisible reconnect sync.
--
-- On every (re)connect, ws/offline-drain.ts pages through a device's
-- undelivered messages:
--   WHERE recipient_device_id = $1 AND recipient_user_id = $2
--     AND delivered_at IS NULL AND expires_at > now()
--     AND (created_at, id) > ($cursor)
--   ORDER BY created_at, id LIMIT n
--
-- The only supporting index was idx_pending_messages_recipient_device
-- (recipient_device_id alone), so each page re-read and sorted the device's
-- whole undelivered backlog. With a large backlog that delay is what a
-- user would perceive after reconnecting; WEB-R1.5 requires fixing the
-- query rather than showing a "syncing" state.
--
-- This partial index matches the filter and the sort exactly, so each page
-- is a single index range scan that stops after `n` rows. Partial on
-- delivered_at IS NULL keeps it small: delivered rows drop out of it.
--
-- CONCURRENTLY: pending_messages is a hot table; don't lock writers.
-- (CONCURRENTLY cannot run inside a transaction block, so no BEGIN/COMMIT.)
--
-- Run this in: Supabase → SQL Editor → New Query → Run
-- Idempotent: safe to run multiple times.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pending_messages_drain
    ON public.pending_messages (recipient_device_id, created_at, id)
    WHERE delivered_at IS NULL;

-- ============================================================
-- Verification: the drain query should use idx_pending_messages_drain.
--   EXPLAIN SELECT id FROM public.pending_messages
--   WHERE recipient_device_id = '00000000-0000-0000-0000-000000000000'
--     AND delivered_at IS NULL AND expires_at > now()
--   ORDER BY created_at, id LIMIT 100;
-- ============================================================

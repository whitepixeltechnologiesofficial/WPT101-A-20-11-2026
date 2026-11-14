-- ============================================================
-- DB-2.4 verification (Supabase SQL Editor edition)
--
-- Use this when outbound TCP 5432 is blocked and the Node test
-- (src/db/db24-blocks-reports-e2e-test.ts) cannot connect.
--
-- WRITES NOTHING: all test rows live inside an inner block that is
-- rolled back by a deliberate exception; only the PASS/FAIL results
-- (held in a temp table) survive to the final SELECT.
--
-- The "can message?" check uses the exact predicate of
-- hasBlockBetween() in src/routes/relay.ts, which is what /relay/send
-- calls before accepting a message (403 when it returns true).
--
-- Run AFTER migration 020: Supabase -> SQL Editor -> paste -> Run.
-- ============================================================

DROP TABLE IF EXISTS pg_temp.db24_results;
CREATE TEMP TABLE db24_results (n serial, check_name text, result text);

DO $$
DECLARE
    r        text[] := '{}';
    a        text := 'db24_verify_alice_' || gen_random_uuid();
    b        text := 'db24_verify_bob_'   || gen_random_uuid();
    v_rep    uuid;
    v_stored int := 0;
    v_n      int;
    v_real0  int;
    v_ok     boolean;
    i        int;
BEGIN
    -- ── Tables ─────────────────────────────────────────────
    FOR i IN 1..5 LOOP
        r := r || ARRAY[
            'table ' || (ARRAY['blocks','reports','report_evidence','test_reports','test_report_evidence'])[i] || ' exists',
            CASE WHEN to_regclass('public.' || (ARRAY['blocks','reports','report_evidence','test_reports','test_report_evidence'])[i]) IS NOT NULL
                 THEN 'PASS' ELSE 'FAIL' END];
    END LOOP;

    BEGIN  -- inner block: everything here is rolled back at the end
        SELECT count(*) INTO v_real0 FROM public.reports;

        -- ── Bidirectional block ────────────────────────────
        INSERT INTO public.blocks (blocker_phone_hash, blocked_phone_hash) VALUES (a, b);

        -- Alice (blocker) -> Bob
        SELECT EXISTS (SELECT 1 FROM public.blocks
            WHERE (blocker_phone_hash = a AND blocked_phone_hash = b)
               OR (blocker_phone_hash = b AND blocked_phone_hash = a)) INTO v_ok;
        r := r || ARRAY['Alice (blocker) -> Bob is blocked', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

        -- Bob (blocked) -> Alice
        SELECT EXISTS (SELECT 1 FROM public.blocks
            WHERE (blocker_phone_hash = b AND blocked_phone_hash = a)
               OR (blocker_phone_hash = a AND blocked_phone_hash = b)) INTO v_ok;
        r := r || ARRAY['Bob (blocked) -> Alice is blocked', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

        -- Self-block rejected
        BEGIN
            INSERT INTO public.blocks VALUES (a, a);
            r := r || ARRAY['self-block rejected', 'FAIL'];
        EXCEPTION WHEN check_violation THEN
            r := r || ARRAY['self-block rejected', 'PASS'];
        END;

        -- Unblock restores both directions
        DELETE FROM public.blocks WHERE blocker_phone_hash = a AND blocked_phone_hash = b;
        SELECT NOT EXISTS (SELECT 1 FROM public.blocks
            WHERE (blocker_phone_hash = a AND blocked_phone_hash = b)
               OR (blocker_phone_hash = b AND blocked_phone_hash = a)) INTO v_ok;
        r := r || ARRAY['after unblock, both directions open', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

        -- ── test_reports / test_report_evidence ────────────
        INSERT INTO public.test_reports (reporter_phone_hash, reported_phone_hash, reason_category)
        VALUES (a, b, 'harassment') RETURNING id INTO v_rep;

        SELECT status = 'pending' AND evidence_expires_at = created_at + interval '30 days'
          INTO v_ok FROM public.test_reports WHERE id = v_rep;
        r := r || ARRAY['test report: pending + expires at +30d', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

        BEGIN
            INSERT INTO public.test_report_evidence (test_report_id, message_content, message_created_at)
            VALUES (v_rep, 'old', now() - interval '8 days');
            r := r || ARRAY['8-day-old message rejected (7-day limit)', 'FAIL'];
        EXCEPTION WHEN raise_exception THEN
            r := r || ARRAY['8-day-old message rejected (7-day limit)', 'PASS'];
        END;

        FOR i IN 1..25 LOOP
            BEGIN
                INSERT INTO public.test_report_evidence (test_report_id, message_content, message_created_at)
                VALUES (v_rep, 'msg ' || i, now() - make_interval(mins => i));
                v_stored := v_stored + 1;
            EXCEPTION WHEN raise_exception THEN
                NULL;
            END;
        END LOOP;
        r := r || ARRAY['25 recent messages -> 20 stored (20 limit)',
                        CASE WHEN v_stored = 20 THEN 'PASS' ELSE 'FAIL (' || v_stored || ')' END];

        SELECT jsonb_array_length(decrypted_message_snapshot) INTO v_n FROM public.test_reports WHERE id = v_rep;
        r := r || ARRAY['test report snapshot holds 20', CASE WHEN v_n = 20 THEN 'PASS' ELSE 'FAIL (' || v_n || ')' END];

        SELECT count(*) INTO v_n FROM public.reports;
        r := r || ARRAY['real reports untouched', CASE WHEN v_n = v_real0 THEN 'PASS' ELSE 'FAIL' END];

        RAISE EXCEPTION 'db24_rollback';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'db24_rollback' THEN RAISE; END IF;
    END;

    FOR i IN 1..array_length(r, 1) BY 2 LOOP
        INSERT INTO db24_results (check_name, result) VALUES (r[i], r[i + 1]);
    END LOOP;
END
$$;

SELECT check_name, result FROM db24_results ORDER BY n;

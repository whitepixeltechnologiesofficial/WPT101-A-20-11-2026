-- ============================================================
-- DB-2.6 verification (Supabase SQL Editor edition)
--
-- Checks all eight §6.8 supporting tables exist, that sessions and
-- dashboard_sessions are genuinely TWO SEPARATE TABLES (not one table
-- with a "type" column), and exercises the four tables added by
-- migration 021.
--
-- WRITES NOTHING: test rows are rolled back by a deliberate exception;
-- only the PASS/FAIL list survives to the final SELECT.
--
-- Run AFTER migration 021: Supabase -> SQL Editor -> paste -> Run.
-- ============================================================

DROP TABLE IF EXISTS pg_temp.db26_results;
CREATE TEMP TABLE db26_results (n serial, check_name text, result text);

DO $$
DECLARE
    r       text[] := '{}';
    t       text;
    v_ok    boolean;
    v_n     int;
    v_admin uuid;
    v_dev   uuid;
    v_user  text;
    v_user2 text;
    v_uid_t text;
BEGIN
    -- ── All eight tables exist ─────────────────────────────
    FOREACH t IN ARRAY ARRAY['otp_verifications','sessions','dashboard_sessions','push_tokens',
                             'chat_mutes','legal_acceptances','rate_limit_counters','sms_outbox'] LOOP
        r := r || ARRAY['table ' || t || ' exists',
                        CASE WHEN to_regclass('public.' || t) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END];
    END LOOP;

    -- ── sessions vs dashboard_sessions: two separate tables ─
    SELECT 'public.sessions'::regclass <> 'public.dashboard_sessions'::regclass
       AND (SELECT relkind FROM pg_class WHERE oid = 'public.dashboard_sessions'::regclass) = 'r'
      INTO v_ok;
    r := r || ARRAY['dashboard_sessions is its own base table (not a view of sessions)',
                    CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

    SELECT NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('sessions','dashboard_sessions')
          AND column_name IN ('type','kind','session_type','is_dashboard','audience')) INTO v_ok;
    r := r || ARRAY['no "type"-style discriminator column on either table',
                    CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

    SELECT NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conrelid = 'public.sessions'::regclass AND contype = 'f'
                         AND confrelid = 'public.dashboard_admins'::regclass) INTO v_ok;
    r := r || ARRAY['sessions has no link to dashboard_admins', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

    SELECT bool_and(confrelid = 'public.dashboard_admins'::regclass) AND count(*) = 1
      INTO v_ok FROM pg_constraint
     WHERE conrelid = 'public.dashboard_sessions'::regclass AND contype = 'f';
    r := r || ARRAY['dashboard_sessions links ONLY to dashboard_admins', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

    BEGIN  -- inner block: everything below is rolled back
        -- A dashboard session must belong to a real admin.
        BEGIN
            INSERT INTO public.dashboard_sessions (dashboard_admin_id, token_lookup, token_hash, expires_at)
            VALUES (gen_random_uuid(), 'x', 'x', now() + interval '1 hour');
            r := r || ARRAY['dashboard session for a non-admin rejected', 'FAIL'];
        EXCEPTION WHEN foreign_key_violation THEN
            r := r || ARRAY['dashboard session for a non-admin rejected', 'PASS'];
        END;

        -- A dashboard session row never appears in sessions.
        INSERT INTO public.dashboard_admins (email, password_hash)
        VALUES ('db26-verify-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_admin;
        SELECT count(*) INTO v_n FROM public.sessions;
        INSERT INTO public.dashboard_sessions (dashboard_admin_id, token_lookup, token_hash, expires_at)
        VALUES (v_admin, 'db26verifylookup', repeat('x', 60), now() + interval '1 hour');
        SELECT (SELECT count(*) FROM public.sessions) = v_n
           AND NOT EXISTS (SELECT 1 FROM public.sessions WHERE token_lookup = 'db26verifylookup') INTO v_ok;
        r := r || ARRAY['dashboard login writes nothing to sessions', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

        -- ── push_tokens ────────────────────────────────────
        SELECT format_type(atttypid, atttypmod) INTO v_uid_t
          FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'id';
        v_user  := gen_random_uuid()::text;
        v_user2 := gen_random_uuid()::text;
        EXECUTE format('INSERT INTO public.users (id, phone_number, name) VALUES ($1::%s, $2, $3), ($4::%s, $5, $6)', v_uid_t, v_uid_t)
          USING v_user, '+19990000001', 'db26 a', v_user2, '+19990000002', 'db26 b';
        EXECUTE format('INSERT INTO public.devices (user_id, device_type, platform, identity_public_key)
                        VALUES ($1::%s, ''phone'', ''android'', ''db26'') RETURNING id', v_uid_t)
          INTO v_dev USING v_user;

        INSERT INTO public.push_tokens (device_id, provider, token) VALUES (v_dev, 'fcm', 'db26-token');
        BEGIN
            INSERT INTO public.push_tokens (device_id, provider, token) VALUES (v_dev, 'fcm', 'db26-token-2');
            r := r || ARRAY['one push token per device per provider', 'FAIL'];
        EXCEPTION WHEN unique_violation THEN
            r := r || ARRAY['one push token per device per provider', 'PASS'];
        END;
        DELETE FROM public.devices WHERE id = v_dev;
        SELECT NOT EXISTS (SELECT 1 FROM public.push_tokens WHERE device_id = v_dev) INTO v_ok;
        r := r || ARRAY['deleting a device removes its push token', CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END];

        -- ── chat_mutes ─────────────────────────────────────
        EXECUTE 'INSERT INTO public.chat_mutes (user_id, muted_user_id) SELECT a.id, b.id FROM public.users a, public.users b
                 WHERE a.id::text = $1 AND b.id::text = $2' USING v_user, v_user2;
        SELECT count(*) INTO v_n FROM public.chat_mutes WHERE user_id::text = v_user;
        r := r || ARRAY['mute a 1:1 chat', CASE WHEN v_n = 1 THEN 'PASS' ELSE 'FAIL' END];
        BEGIN
            EXECUTE 'INSERT INTO public.chat_mutes (user_id) SELECT id FROM public.users WHERE id::text = $1' USING v_user;
            r := r || ARRAY['mute with no target rejected', 'FAIL'];
        EXCEPTION WHEN check_violation THEN
            r := r || ARRAY['mute with no target rejected', 'PASS'];
        END;

        -- ── rate_limit_counters ────────────────────────────
        PERFORM public.rate_limit_hit('db26_verify', 'subject', 60);
        PERFORM public.rate_limit_hit('db26_verify', 'subject', 60);
        SELECT public.rate_limit_hit('db26_verify', 'subject', 60) INTO v_n;
        r := r || ARRAY['rate_limit_hit counts 1,2,3 in one window', CASE WHEN v_n = 3 THEN 'PASS' ELSE 'FAIL (' || v_n || ')' END];
        SELECT count(*) INTO v_n FROM public.rate_limit_counters WHERE action = 'db26_verify';
        r := r || ARRAY['one counter row per window', CASE WHEN v_n = 1 THEN 'PASS' ELSE 'FAIL (' || v_n || ')' END];

        RAISE EXCEPTION 'db26_rollback';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'db26_rollback' THEN RAISE; END IF;
    END;

    FOR i IN 1..array_length(r, 1) BY 2 LOOP
        INSERT INTO db26_results (check_name, result) VALUES (r[i], r[i + 1]);
    END LOOP;
END
$$;

SELECT check_name, result FROM db26_results ORDER BY n;

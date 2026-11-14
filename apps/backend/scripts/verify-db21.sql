-- DB-2.1 verification — run in the Supabase SQL editor after migration 022.
-- Read-only: every row should say PASS.

SELECT 'users.id is uuid' AS check_name,
       CASE WHEN data_type = 'uuid' THEN 'PASS' ELSE 'FAIL (' || data_type || ')' END AS result
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'

UNION ALL
SELECT 'users.id defaults to gen_random_uuid()',
       CASE WHEN column_default LIKE 'gen_random_uuid()%' THEN 'PASS' ELSE 'FAIL (' || coalesce(column_default, 'none') || ')' END
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'

UNION ALL
SELECT 'users.phone_number is unique',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = 'public.users'::regclass AND i.indisunique AND a.attname = 'phone_number'
       ) THEN 'PASS' ELSE 'FAIL' END

UNION ALL
SELECT 'account_status enum has active|warned|restricted|banned',
       CASE WHEN (
         SELECT array_agg(e.enumlabel ORDER BY e.enumlabel)
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'account_status' AND n.nspname = 'public'
       ) = ARRAY['active', 'banned', 'restricted', 'warned']::name[] THEN 'PASS' ELSE 'FAIL' END

UNION ALL
SELECT 'users.account_status NOT NULL default active',
       CASE WHEN is_nullable = 'NO' AND column_default LIKE '''active''%' THEN 'PASS'
            ELSE 'FAIL (' || is_nullable || ', ' || coalesce(column_default, 'none') || ')' END
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'account_status'

UNION ALL
SELECT 'users_account_status_idx exists',
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_account_status_idx')
            THEN 'PASS' ELSE 'FAIL' END

UNION ALL
SELECT 'every FK into users.id is uuid',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass AND a.atttypid <> 'uuid'::regtype
       ) THEN 'PASS' ELSE 'FAIL' END;

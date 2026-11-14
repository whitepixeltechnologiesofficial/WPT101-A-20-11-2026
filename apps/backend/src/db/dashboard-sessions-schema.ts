/**
 * DB-2.6 — Dashboard sessions table (migration 021).
 *
 * Admin Dashboard logins ONLY. Deliberately a separate table from
 * `sessions` (user/device auth): its only FK is dashboard_admins(id),
 * so dashboard and user auth can never share a session row.
 *
 * Token model mirrors `sessions`: token_lookup (first 32 hex chars of
 * SHA-256) for indexed lookup, token_hash (bcrypt) for verification,
 * revoked_at as the kill switch. The raw token is never stored.
 */

import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { dashboardAdmins } from "./dashboard-admins-schema.js";

export const dashboardSessions = pgTable(
  "dashboard_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardAdminId: uuid("dashboard_admin_id")
      .notNull()
      .references(() => dashboardAdmins.id, { onDelete: "cascade" }),
    tokenLookup: varchar("token_lookup", { length: 32 }).notNull(),
    tokenHash: varchar("token_hash", { length: 60 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dashboard_sessions_token_lookup_uidx").on(table.tokenLookup),
    index("dashboard_sessions_admin_id_idx").on(table.dashboardAdminId),
  ],
);

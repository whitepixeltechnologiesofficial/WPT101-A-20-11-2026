/**
 * DB-2.6 — Push tokens table (migration 021).
 *
 * One notification token per device per provider (FCM / APNs / Web Push).
 * For web_push, `token` holds the serialized subscription JSON
 * (endpoint + keys). Deleting a device cascades to its token.
 */

import { pgTable, pgEnum, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { devices } from "./devices-schema.js";

export const pushProvider = pgEnum("push_provider", ["fcm", "apns", "web_push"]);

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    provider: pushProvider("provider").notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("push_tokens_device_provider_uidx").on(table.deviceId, table.provider),
    uniqueIndex("push_tokens_provider_token_uidx").on(table.provider, table.token),
  ],
);

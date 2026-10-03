import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("bridge_jobs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  connectorId: text("connector_id").notNull(),
  requestId: text("request_id"),
  tool: text("tool").notNull(),
  arguments: text("arguments").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  claimedAt: integer("claimed_at"),
  result: text("result"),
}, (table) => [index("idx_bridge_jobs_queue").on(table.connectorId, table.status, table.createdAt)]);

export const connector = sqliteTable("bridge_connector", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  status: text("status").notNull(),
  lastSeen: integer("last_seen").notNull(),
}, (table) => [uniqueIndex("idx_bridge_connector_owner").on(table.ownerId)]);

import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { browserImageSourceKinds } from "@shared/browser/artifact";
import { workspaceMemberships } from "./workspaces";

export const browserSessions = pgTable(
  "browser_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    workerSessionId: text("worker_session_id"),
  },
  (table) => [
    foreignKey({
      name: "browser_sessions_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("browser_sessions_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
    index("browser_sessions_worker_idx").on(
      table.workspaceId,
      table.workerSessionId
    ),
  ]
);

export const browserTraces = pgTable(
  "browser_traces",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    task: text("task").notNull(),
    status: text("status", {
      enum: ["running", "success", "failure", "error", "cancelled"],
    }).notNull(),
    resultMessage: text("result_message"),
    startedAt: timestamp("started_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    foreignKey({
      name: "browser_traces_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "browser_traces_status_check",
      sql`${table.status} IN ('running', 'success', 'failure', 'error', 'cancelled')`
    ),
    check(
      "browser_traces_duration_ms_check",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`
    ),
    index("browser_traces_workspace_started_idx").on(
      table.workspaceId,
      table.startedAt.desc().nullsFirst()
    ),
  ]
);

export const browserTraceEvents = pgTable(
  "browser_trace_events",
  {
    id: text("id").primaryKey(),
    traceSessionId: text("trace_session_id").notNull(),
    at: timestamp("at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    type: text("type").notNull(),
    label: text("label").notNull(),
    detail: text("detail").notNull(),
  },
  (table) => [
    foreignKey({
      name: "browser_trace_events_trace_fkey",
      columns: [table.traceSessionId],
      foreignColumns: [browserTraces.sessionId],
    }).onDelete("cascade"),
    index("browser_trace_events_trace_idx").on(table.traceSessionId, table.id),
  ]
);

export const browserTraceDomains = pgTable(
  "browser_trace_domains",
  {
    traceSessionId: text("trace_session_id").notNull(),
    domain: text("domain").notNull(),
    firstSeenAt: timestamp("first_seen_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.traceSessionId, table.domain],
      name: "browser_trace_domains_pkey",
    }),
    foreignKey({
      name: "browser_trace_domains_trace_fkey",
      columns: [table.traceSessionId],
      foreignColumns: [browserTraces.sessionId],
    }).onDelete("cascade"),
    index("browser_trace_domains_domain_idx").on(table.domain),
  ]
);

export const browserImageArtifacts = pgTable(
  "browser_image_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    workerSessionId: text("worker_session_id").notNull(),
    browserSessionId: text("browser_session_id").notNull(),
    status: text("status", { enum: ["pending", "ready"] }).notNull(),
    label: text("label").notNull(),
    filename: text("filename"),
    mediaType: text("media_type"),
    byteSize: integer("byte_size"),
    contentHash: text("content_hash"),
    storagePathname: text("storage_pathname").notNull(),
    sourceKind: text("source_kind", {
      enum: browserImageSourceKinds,
    }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "browser_image_artifacts_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "browser_image_artifacts_status_check",
      sql`${table.status} IN ('pending', 'ready')`
    ),
    check(
      "browser_image_artifacts_source_kind_check",
      sql`${table.sourceKind} IN ('element', 'full_page', 'image_resource', 'viewport')`
    ),
    check(
      "browser_image_artifacts_ready_fields_check",
      sql`${table.status} = 'pending' OR (${table.filename} IS NOT NULL AND ${table.mediaType} IS NOT NULL AND ${table.byteSize} > 0 AND ${table.contentHash} IS NOT NULL)`
    ),
    uniqueIndex("browser_image_artifacts_workspace_idempotency_uidx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index("browser_image_artifacts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const browserSessionsRelations = relations(
  browserSessions,
  ({ one }) => ({
    membership: one(workspaceMemberships, {
      fields: [browserSessions.workspaceId, browserSessions.createdByUserId],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

export const browserTracesRelations = relations(
  browserTraces,
  ({ many, one }) => ({
    domains: many(browserTraceDomains),
    events: many(browserTraceEvents),
    membership: one(workspaceMemberships, {
      fields: [browserTraces.workspaceId, browserTraces.createdByUserId],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

export const browserTraceEventsRelations = relations(
  browserTraceEvents,
  ({ one }) => ({
    trace: one(browserTraces, {
      fields: [browserTraceEvents.traceSessionId],
      references: [browserTraces.sessionId],
    }),
  })
);

export const browserTraceDomainsRelations = relations(
  browserTraceDomains,
  ({ one }) => ({
    trace: one(browserTraces, {
      fields: [browserTraceDomains.traceSessionId],
      references: [browserTraces.sessionId],
    }),
  })
);

export const browserImageArtifactsRelations = relations(
  browserImageArtifacts,
  ({ one }) => ({
    membership: one(workspaceMemberships, {
      fields: [
        browserImageArtifacts.workspaceId,
        browserImageArtifacts.createdByUserId,
      ],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

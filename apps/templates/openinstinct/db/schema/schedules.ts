import { relations, sql } from "drizzle-orm";
import type { Interaction } from "eve/events";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";

export const scheduledAgentJobs = pgTable(
  "scheduled_agent_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    prompt: text("prompt").notNull(),
    conversationChannel: text("conversation_channel", {
      enum: ["eve", "linq"],
    }).notNull(),
    conversationId: text("conversation_id").notNull(),
    replyAnchorMessageId: text("reply_anchor_message_id"),
    timing: jsonb("timing").notNull(),
    missedRunPolicy: text("missed_run_policy", {
      enum: ["skip", "run_latest", "catch_up"],
    })
      .notNull()
      .default("run_latest"),
    status: text("status", {
      enum: ["active", "paused", "completed", "deleted"],
    })
      .notNull()
      .default("active"),
    nextRunAt: timestamp("next_run_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    lastRunAt: timestamp("last_run_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    lastError: text("last_error"),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "scheduled_agent_jobs_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "scheduled_agent_jobs_conversation_channel_check",
      sql`${table.conversationChannel} IN ('eve', 'linq')`
    ),
    check(
      "scheduled_agent_jobs_conversation_id_check",
      sql`${table.conversationId} <> ''`
    ),
    check(
      "scheduled_agent_jobs_missed_run_policy_check",
      sql`${table.missedRunPolicy} IN ('skip', 'run_latest', 'catch_up')`
    ),
    check(
      "scheduled_agent_jobs_status_check",
      sql`${table.status} IN ('active', 'paused', 'completed', 'deleted')`
    ),
    index("scheduled_agent_jobs_due_idx").on(
      table.status,
      table.nextRunAt.asc().nullsLast()
    ),
    index("scheduled_agent_jobs_owner_idx").on(
      table.workspaceId,
      table.createdByUserId,
      table.conversationChannel,
      table.conversationId,
      table.nextRunAt.asc().nullsLast()
    ),
  ]
);

export const scheduledAgentRuns = pgTable(
  "scheduled_agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => scheduledAgentJobs.id, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "waiting_for_input",
        "completed",
        "dead_letter",
      ],
    })
      .notNull()
      .default("queued"),
    workerSessionId: text("worker_session_id"),
    // Retained for installations still serving pre-1.0 sessions. New runs do not defer by turn.
    deferredCompletionTurnId: text("deferred_completion_turn_id"),
    pendingInputRequests: jsonb("pending_input_requests").$type<
      readonly Interaction[]
    >(),
    outcome: jsonb("outcome"),
    reportStatus: text("report_status", {
      enum: [
        "not_ready",
        "not_needed",
        "pending",
        "queued",
        "delivered",
        "suppressed",
      ],
    })
      .notNull()
      .default("not_ready"),
    reportSequence: integer("report_sequence").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    retryAt: timestamp("retry_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    reportLeaseToken: uuid("report_lease_token"),
    reportLeaseExpiresAt: timestamp("report_lease_expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "scheduled_agent_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'waiting_for_input', 'completed', 'dead_letter')`
    ),
    check(
      "scheduled_agent_runs_report_status_check",
      sql`${table.reportStatus} IN ('not_ready', 'not_needed', 'pending', 'queued', 'delivered', 'suppressed')`
    ),
    uniqueIndex("scheduled_agent_runs_occurrence_idx").on(
      table.jobId,
      table.scheduledFor
    ),
    index("scheduled_agent_runs_ready_idx").on(
      table.status,
      table.retryAt.asc().nullsFirst()
    ),
    index("scheduled_agent_runs_report_idx").on(
      table.reportStatus,
      table.updatedAt.asc()
    ),
  ]
);

export const scheduledAgentJobsRelations = relations(
  scheduledAgentJobs,
  ({ many, one }) => ({
    membership: one(workspaceMemberships, {
      fields: [
        scheduledAgentJobs.workspaceId,
        scheduledAgentJobs.createdByUserId,
      ],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
    runs: many(scheduledAgentRuns),
  })
);

export const scheduledAgentRunsRelations = relations(
  scheduledAgentRuns,
  ({ one }) => ({
    job: one(scheduledAgentJobs, {
      fields: [scheduledAgentRuns.jobId],
      references: [scheduledAgentJobs.id],
    }),
  })
);

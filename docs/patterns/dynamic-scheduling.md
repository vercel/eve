---
title: "Dynamic scheduling"
description: "Build database-backed, tenant-scoped schedules with CRUD tools and one minute-level eve dispatcher."
---

Authored eve schedules are static files discovered at build time. This example builds a dynamic layer on top: tenants create schedule rows through tools, one authored schedule wakes every minute, claims due rows from PostgreSQL, and starts an agent session for each one.

Dynamic schedules are not a framework-native resource. PostgreSQL is the source of truth, the CRUD surface is ordinary eve tools, and the minute dispatcher is an ordinary `defineSchedule`. A durable KV store also works if it supports atomic compare-and-set or leases. A plain read followed by a write is not enough when two workers can overlap.

This version delivers scheduled work through Slack, because an eve schedule handler can start proactive sessions with `receive(slack, ...)`. Substitute another proactive channel and its target fields if Slack is not your delivery surface.

```text
agent/
  channels/slack.ts
  lib/
    db.ts
    schedule-store.ts
    tenant.ts
  schedules/dynamic.ts
  tools/
    create_schedule.ts
    delete_schedule.ts
    list_schedules.ts
    update_schedule.ts
```

## 1. Create the durable schedule store

Install the database client:

```sh
pnpm add postgres
```

The application should already have tenants and memberships. The minimal tables below make the security and dispatch assumptions explicit. `tenant_slack_channels` is an allow-list populated by your application when a tenant connects a channel.

```sql title="db/migrations/002_dynamic_schedules.sql"
CREATE TABLE tenant_members (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE tenant_slack_channels (
  tenant_id text NOT NULL,
  channel_id text NOT NULL,
  PRIMARY KEY (tenant_id, channel_id)
);

CREATE TABLE agent_schedules (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  created_by text NOT NULL,
  caller_authenticator text NOT NULL,
  caller_issuer text,
  prompt text NOT NULL,
  slack_channel_id text NOT NULL,
  next_run_at timestamptz NOT NULL,
  every_minutes integer,
  enabled boolean NOT NULL DEFAULT true,
  lease_token uuid,
  lease_until timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES tenant_members (tenant_id, user_id),
  FOREIGN KEY (tenant_id, slack_channel_id)
    REFERENCES tenant_slack_channels (tenant_id, channel_id),
  CHECK (length(prompt) BETWEEN 1 AND 8000),
  CHECK (every_minutes IS NULL OR every_minutes BETWEEN 1 AND 525600)
);

CREATE INDEX agent_schedules_due
  ON agent_schedules (next_run_at)
  WHERE enabled = true;
```

Use the same database setup as the memory example:

```ts title="agent/lib/db.ts"
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

export const sql = postgres(process.env.DATABASE_URL, {
  max: 5,
  prepare: false,
});
```

## 2. Pin every CRUD call to the current tenant

```ts title="agent/lib/tenant.ts"
import type { SessionAuthContext, SessionContext } from "eve/context";

export interface ScheduleOwner {
  auth: SessionAuthContext;
  tenantId: string;
  userId: string;
}

export function requireScheduleOwner(ctx: SessionContext): ScheduleOwner {
  const auth = ctx.session.auth.current;
  const tenantId = auth?.attributes.tenantId;

  if (auth?.principalType !== "user" || typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("An authenticated tenant user is required.");
  }

  return { auth, tenantId, userId: auth.principalId };
}
```

The schedule owner is captured from verified session context. There is no `tenantId` or `createdBy` in any model-controlled tool schema.

## 3. Implement CRUD and leasing

The repository below is the complete persistence boundary. All user-facing operations include `tenant_id`. Only the trusted dispatcher calls the cross-tenant `claimDueSchedules` function.

```ts title="agent/lib/schedule-store.ts"
import { sql } from "./db.js";
import type { ScheduleOwner } from "./tenant.js";

export interface ScheduleRecord {
  id: string;
  prompt: string;
  slackChannelId: string;
  nextRunAt: string;
  everyMinutes: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

interface ScheduleRow {
  id: string;
  prompt: string;
  slack_channel_id: string;
  next_run_at: Date;
  every_minutes: number | null;
  enabled: boolean;
  last_run_at: Date | null;
  last_error: string | null;
}

function publicRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    prompt: row.prompt,
    slackChannelId: row.slack_channel_id,
    nextRunAt: row.next_run_at.toISOString(),
    everyMinutes: row.every_minutes,
    enabled: row.enabled,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

async function assertAllowedChannel(tenantId: string, channelId: string) {
  const rows = await sql`
    SELECT 1
    FROM tenant_slack_channels
    WHERE tenant_id = ${tenantId} AND channel_id = ${channelId}
  `;
  if (rows.length !== 1) throw new Error("Slack channel is not enabled for this tenant.");
}

export async function createSchedule(
  owner: ScheduleOwner,
  input: {
    prompt: string;
    slackChannelId: string;
    firstRunAt: Date;
    everyMinutes: number | null;
  },
): Promise<ScheduleRecord> {
  await assertAllowedChannel(owner.tenantId, input.slackChannelId);
  const id = crypto.randomUUID();
  const [row] = await sql<ScheduleRow[]>`
    INSERT INTO agent_schedules (
      id, tenant_id, created_by, caller_authenticator, caller_issuer,
      prompt, slack_channel_id, next_run_at, every_minutes
    ) VALUES (
      ${id}, ${owner.tenantId}, ${owner.userId}, ${owner.auth.authenticator},
      ${owner.auth.issuer ?? null}, ${input.prompt}, ${input.slackChannelId},
      ${input.firstRunAt}, ${input.everyMinutes}
    )
    RETURNING id, prompt, slack_channel_id, next_run_at, every_minutes,
      enabled, last_run_at, last_error
  `;
  if (!row) throw new Error("Schedule insert returned no row.");
  return publicRecord(row);
}

export async function listSchedules(owner: ScheduleOwner): Promise<ScheduleRecord[]> {
  const rows = await sql<ScheduleRow[]>`
    SELECT id, prompt, slack_channel_id, next_run_at, every_minutes,
      enabled, last_run_at, last_error
    FROM agent_schedules
    WHERE tenant_id = ${owner.tenantId}
    ORDER BY created_at DESC
  `;
  return rows.map(publicRecord);
}

export async function updateSchedule(
  owner: ScheduleOwner,
  id: string,
  patch: {
    prompt?: string;
    slackChannelId?: string;
    nextRunAt?: Date;
    everyMinutes?: number | null;
    enabled?: boolean;
  },
): Promise<ScheduleRecord> {
  if (patch.slackChannelId) {
    await assertAllowedChannel(owner.tenantId, patch.slackChannelId);
  }

  const [current] = await sql<ScheduleRow[]>`
    SELECT id, prompt, slack_channel_id, next_run_at, every_minutes,
      enabled, last_run_at, last_error
    FROM agent_schedules
    WHERE tenant_id = ${owner.tenantId} AND id = ${id}
  `;
  if (!current) throw new Error("Schedule not found.");

  const [row] = await sql<ScheduleRow[]>`
    UPDATE agent_schedules
    SET prompt = ${patch.prompt ?? current.prompt},
        slack_channel_id = ${patch.slackChannelId ?? current.slack_channel_id},
        next_run_at = ${patch.nextRunAt ?? current.next_run_at},
        every_minutes = ${
          patch.everyMinutes === undefined ? current.every_minutes : patch.everyMinutes
        },
        enabled = ${patch.enabled ?? current.enabled},
        lease_token = NULL,
        lease_until = NULL,
        last_error = NULL,
        updated_at = now()
    WHERE tenant_id = ${owner.tenantId} AND id = ${id}
    RETURNING id, prompt, slack_channel_id, next_run_at, every_minutes,
      enabled, last_run_at, last_error
  `;
  if (!row) throw new Error("Schedule update returned no row.");
  return publicRecord(row);
}

export async function deleteSchedule(owner: ScheduleOwner, id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM agent_schedules
    WHERE tenant_id = ${owner.tenantId} AND id = ${id}
    RETURNING id
  `;
  return rows.length === 1;
}

export interface ClaimedSchedule {
  id: string;
  tenantId: string;
  userId: string;
  memberRole: string;
  authenticator: string;
  issuer: string | null;
  prompt: string;
  slackChannelId: string;
  everyMinutes: number | null;
  leaseToken: string;
}

export async function claimDueSchedules(limit = 25): Promise<ClaimedSchedule[]> {
  return await sql.begin(async (tx) => {
    const due = await tx<
      {
        id: string;
        tenant_id: string;
        created_by: string;
        role: string;
        caller_authenticator: string;
        caller_issuer: string | null;
        prompt: string;
        slack_channel_id: string;
        every_minutes: number | null;
      }[]
    >`
      SELECT s.id, s.tenant_id, s.created_by, m.role,
        s.caller_authenticator, s.caller_issuer, s.prompt,
        s.slack_channel_id, s.every_minutes
      FROM agent_schedules s
      JOIN tenant_members m
        ON m.tenant_id = s.tenant_id AND m.user_id = s.created_by
      WHERE s.enabled = true
        AND m.active = true
        AND s.next_run_at <= now()
        AND (s.lease_until IS NULL OR s.lease_until < now())
      ORDER BY s.next_run_at
      LIMIT ${limit}
      FOR UPDATE OF s SKIP LOCKED
    `;

    const claimed: ClaimedSchedule[] = [];
    for (const row of due) {
      const leaseToken = crypto.randomUUID();
      await tx`
        UPDATE agent_schedules
        SET lease_token = ${leaseToken}, lease_until = now() + interval '5 minutes'
        WHERE id = ${row.id}
      `;
      claimed.push({
        id: row.id,
        tenantId: row.tenant_id,
        userId: row.created_by,
        memberRole: row.role,
        authenticator: row.caller_authenticator,
        issuer: row.caller_issuer,
        prompt: row.prompt,
        slackChannelId: row.slack_channel_id,
        everyMinutes: row.every_minutes,
        leaseToken,
      });
    }
    return claimed;
  });
}

export async function markScheduleDispatched(job: ClaimedSchedule): Promise<void> {
  const nextRunAt =
    job.everyMinutes === null ? null : new Date(Date.now() + job.everyMinutes * 60_000);

  await sql`
    UPDATE agent_schedules
    SET enabled = ${job.everyMinutes !== null},
        next_run_at = COALESCE(${nextRunAt}, next_run_at),
        last_run_at = now(),
        last_error = NULL,
        lease_token = NULL,
        lease_until = NULL,
        updated_at = now()
    WHERE id = ${job.id} AND lease_token = ${job.leaseToken}
  `;
}

export async function releaseSchedule(job: ClaimedSchedule, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE agent_schedules
    SET next_run_at = now() + interval '5 minutes',
        last_error = ${message.slice(0, 1000)},
        lease_token = NULL,
        lease_until = NULL,
        updated_at = now()
    WHERE id = ${job.id} AND lease_token = ${job.leaseToken}
  `;
}
```

`FOR UPDATE ... SKIP LOCKED` prevents two dispatcher instances from claiming the same row at once. The lease recovers work if a process dies. Delivery is still **at least once**: a crash after `receive` succeeds but before `markScheduleDispatched` can produce a retry. Make side-effecting scheduled prompts idempotent, using the schedule id and `last_run_at` as application-level keys where needed.

## 4. Expose CRUD tools

Use one tool per operation so the model sees a small, explicit surface.

```ts title="agent/tools/create_schedule.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { createSchedule } from "../lib/schedule-store.js";
import { requireScheduleOwner } from "../lib/tenant.js";

export default defineTool({
  description: "Create a one-time or repeating scheduled agent run for this tenant.",
  inputSchema: z.object({
    prompt: z.string().min(1).max(8000),
    slackChannelId: z.string().min(1),
    firstRunAt: z.string().datetime({ offset: true }),
    everyMinutes: z.number().int().min(1).max(525600).nullable().default(null),
  }),
  async execute(input, ctx) {
    return await createSchedule(requireScheduleOwner(ctx), {
      ...input,
      firstRunAt: new Date(input.firstRunAt),
    });
  },
});
```

```ts title="agent/tools/list_schedules.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { listSchedules } from "../lib/schedule-store.js";
import { requireScheduleOwner } from "../lib/tenant.js";

export default defineTool({
  description: "List this tenant's dynamic schedules and their latest status.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return await listSchedules(requireScheduleOwner(ctx));
  },
});
```

```ts title="agent/tools/update_schedule.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateSchedule } from "../lib/schedule-store.js";
import { requireScheduleOwner } from "../lib/tenant.js";

export default defineTool({
  description: "Change, pause, or resume one of this tenant's dynamic schedules.",
  inputSchema: z.object({
    id: z.string().uuid(),
    prompt: z.string().min(1).max(8000).optional(),
    slackChannelId: z.string().min(1).optional(),
    nextRunAt: z.string().datetime({ offset: true }).optional(),
    everyMinutes: z.number().int().min(1).max(525600).nullable().optional(),
    enabled: z.boolean().optional(),
  }),
  async execute({ id, nextRunAt, ...patch }, ctx) {
    return await updateSchedule(requireScheduleOwner(ctx), id, {
      ...patch,
      ...(nextRunAt ? { nextRunAt: new Date(nextRunAt) } : {}),
    });
  },
});
```

```ts title="agent/tools/delete_schedule.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { deleteSchedule } from "../lib/schedule-store.js";
import { requireScheduleOwner } from "../lib/tenant.js";

export default defineTool({
  description: "Permanently delete one of this tenant's dynamic schedules.",
  inputSchema: z.object({ id: z.string().uuid() }),
  approval: always(),
  async execute({ id }, ctx) {
    return { deleted: await deleteSchedule(requireScheduleOwner(ctx), id) };
  },
});
```

## 5. Configure the proactive channel

Set up Slack as documented in [Slack](../channels/slack). With Vercel Connect, the channel file is:

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
});
```

## 6. Dispatch due rows every minute

This is the only authored schedule. Its handler does not receive `ctx.session`, so it loads tenant identity from the claimed database row, revalidated by the active-membership join, and passes that auth explicitly into `receive`.

```ts title="agent/schedules/dynamic.ts"
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import {
  claimDueSchedules,
  markScheduleDispatched,
  releaseSchedule,
} from "../lib/schedule-store.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ receive, waitUntil }) {
    waitUntil(
      (async () => {
        const jobs = await claimDueSchedules(25);

        await Promise.all(
          jobs.map(async (job) => {
            try {
              await receive(slack, {
                message: [
                  `Run dynamic schedule ${job.id}.`,
                  "Complete the following tenant-owned task:",
                  job.prompt,
                ].join("\n\n"),
                target: { channelId: job.slackChannelId },
                auth: {
                  attributes: {
                    tenantId: job.tenantId,
                    role: job.memberRole,
                    scheduleId: job.id,
                  },
                  authenticator: job.authenticator,
                  ...(job.issuer ? { issuer: job.issuer } : {}),
                  principalId: job.userId,
                  principalType: "user",
                },
              });
              await markScheduleDispatched(job);
            } catch (error) {
              await releaseSchedule(job, error);
            }
          }),
        );
      })(),
    );
  },
});
```

`waitUntil` keeps the cron invocation alive until the database work and all proactive handoffs settle. The sessions started by `receive` use eve's normal durable runtime.

## 7. Tell the model how to schedule

```md title="agent/instructions.md"
When creating a schedule, confirm the user's intended time zone and convert the
first run to an ISO 8601 timestamp with an explicit offset. Use everyMinutes
only for a repeating schedule; use null for a one-time run. List schedules
before changing an ambiguous one. Never invent a Slack channel id: ask the user
to select an enabled tenant channel.
```

## Production checks

- Keep user CRUD tenant-scoped and keep the cross-tenant claim function private to the dispatcher.
- Revalidate membership and channel ownership at dispatch time, not only when the schedule is created.
- Use database time for due/lease comparisons and store timestamps as `timestamptz`.
- Decide whether recurring jobs skip missed intervals, as this example does, or catch up.
- Set concurrency and batch limits appropriate to your host's one-minute execution budget.
- Add idempotency to side-effecting work and monitor `last_error`, expired leases, and dispatch latency.
- Define cancellation semantics for a row already claimed when a user disables or deletes it.

The dynamic resource belongs to your application; eve supplies the CRUD tool surface, authenticated `ctx.session`, the one-minute trigger, proactive channel handoff, and durable agent sessions.

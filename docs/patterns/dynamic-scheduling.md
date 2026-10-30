---
title: "Dynamic Scheduling"
description: "Compose one minute-level eve schedule, proactive channel handoff, and CRUD tools into application-managed schedules."
---

Dynamic scheduling lets the agent create schedules at runtime while your application stores and runs them. It also works on self-hosted infrastructure. For built-in schedules with management tools that run on Vercel, see [Experimental dynamic schedules](../experimental/dynamic-schedules).

Schedule rows live in your application's store. One static `defineSchedule` file runs them:

1. Create, list, update, and delete tools let the agent manage rows for the current tenant.
2. `defineSchedule({ cron: "* * * * *" })` runs once a minute.
3. The handler atomically claims rows that are due.
4. `to(...).send(...)` starts a normal agent session for each row.

PostgreSQL or a KV store can back the adapter. The adapter needs an atomic lease, not a particular schema.

```text
agent/
  channels/slack.ts
  lib/schedule-store.ts     # your storage adapter
  lib/tenant.ts
  schedules/dynamic.ts
  tools/create_schedule.ts
  tools/delete_schedule.ts
  tools/list_schedules.ts
  tools/update_schedule.ts
```

## Dispatch due schedules every minute

This is the only schedule file. It claims rows that are due and starts a Slack session for each one:

```ts title="agent/schedules/dynamic.ts"
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack";
import { scheduleStore } from "../lib/schedule-store";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      (async () => {
        const jobs = await scheduleStore.claimDue({
          now: new Date(),
          limit: 25,
          leaseForMs: 5 * 60_000,
        });

        await Promise.all(
          jobs.map(async (job) => {
            try {
              await to(slack, { channelId: job.channelId }).send(
                [
                  `Run dynamic schedule ${job.id}.`,
                  "Complete this tenant-owned task:",
                  job.prompt,
                ].join("\n\n"),
                {
                  auth: {
                    attributes: {
                      tenantId: job.tenantId,
                      role: job.ownerRole,
                      scheduleId: job.id,
                    },
                    authenticator: job.authenticator,
                    ...(job.issuer ? { issuer: job.issuer } : {}),
                    principalId: job.ownerId,
                    principalType: "user",
                  },
                },
              );
              await scheduleStore.complete(job);
            } catch (error) {
              await scheduleStore.release(job, { error, retryAt: new Date(Date.now() + 300_000) });
            }
          }),
        );
      })(),
    );
  },
});
```

`waitUntil` keeps the cron invocation running until every claim and send finishes. `to(...).send(...)` starts a session the same way an inbound channel message does.

Slack's target for agent-started messages is `{ channelId }`. Any channel that implements `receive` can replace Slack. The Slack channel needs no special configuration:

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
});
```

## Give the agent CRUD tools

Read the tenant and the user who owns each schedule from `ctx.session`, never from the model:

```ts title="agent/lib/tenant.ts"
import type { SessionAuthContext, SessionContext } from "eve/context";

export function requireScheduleOwner(ctx: SessionContext): {
  tenantId: string;
  userId: string;
  auth: SessionAuthContext;
} {
  const auth = ctx.session.auth.current;
  const tenantId = auth?.attributes.tenantId;
  if (auth?.principalType !== "user" || typeof tenantId !== "string") {
    throw new Error("An authenticated tenant user is required.");
  }
  return { tenantId, userId: auth.principalId, auth };
}
```

Create a one-time schedule with `everyMinutes: null`, or a recurring one with an interval:

```ts title="agent/tools/create_schedule.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { scheduleStore } from "../lib/schedule-store";
import { requireScheduleOwner } from "../lib/tenant";

export default defineTool({
  description: "Create a one-time or repeating scheduled agent run for this tenant.",
  inputSchema: z.object({
    prompt: z.string().min(1).max(8000),
    channelId: z.string().min(1),
    firstRunAt: z.string().datetime({ offset: true }),
    everyMinutes: z.number().int().min(1).max(525600).nullable().default(null),
  }),
  async execute(input, ctx) {
    return await scheduleStore.create(requireScheduleOwner(ctx), {
      ...input,
      firstRunAt: new Date(input.firstRunAt),
    });
  },
});
```

```ts title="agent/tools/list_schedules.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { scheduleStore } from "../lib/schedule-store";
import { requireScheduleOwner } from "../lib/tenant";

export default defineTool({
  description: "List this tenant's dynamic schedules and their latest status.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return await scheduleStore.list(requireScheduleOwner(ctx));
  },
});
```

```ts title="agent/tools/update_schedule.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { scheduleStore } from "../lib/schedule-store";
import { requireScheduleOwner } from "../lib/tenant";

export default defineTool({
  description: "Change, pause, or resume one of this tenant's schedules.",
  inputSchema: z.object({
    id: z.string().uuid(),
    prompt: z.string().min(1).max(8000).optional(),
    channelId: z.string().min(1).optional(),
    nextRunAt: z.string().datetime({ offset: true }).optional(),
    everyMinutes: z.number().int().min(1).max(525600).nullable().optional(),
    enabled: z.boolean().optional(),
  }),
  async execute({ id, nextRunAt, ...patch }, ctx) {
    return await scheduleStore.update(requireScheduleOwner(ctx), id, {
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
import { scheduleStore } from "../lib/schedule-store";
import { requireScheduleOwner } from "../lib/tenant";

export default defineTool({
  description: "Permanently delete one of this tenant's schedules.",
  inputSchema: z.object({ id: z.string().uuid() }),
  approval: always(),
  async execute({ id }, ctx) {
    return { deleted: await scheduleStore.delete(requireScheduleOwner(ctx), id) };
  },
});
```

## Supply the schedule adapter

The tools and the schedule file depend on this interface, not on a database schema:

```ts title="agent/lib/schedule-store.ts"
import type { SessionAuthContext } from "eve/context";

export interface ScheduleOwner {
  tenantId: string;
  userId: string;
  auth: SessionAuthContext;
}

export interface ClaimedSchedule {
  id: string;
  leaseToken: string;
  tenantId: string;
  ownerId: string;
  ownerRole: string;
  authenticator: string;
  issuer?: string;
  prompt: string;
  channelId: string;
  everyMinutes: number | null;
}

export interface ScheduleStore {
  create(owner: ScheduleOwner, input: unknown): Promise<unknown>;
  list(owner: ScheduleOwner): Promise<unknown[]>;
  update(owner: ScheduleOwner, id: string, patch: unknown): Promise<unknown>;
  delete(owner: ScheduleOwner, id: string): Promise<boolean>;
  claimDue(options: { now: Date; limit: number; leaseForMs: number }): Promise<ClaimedSchedule[]>;
  complete(job: ClaimedSchedule): Promise<void>;
  release(job: ClaimedSchedule, failure: { error: unknown; retryAt: Date }): Promise<void>;
}

export { scheduleStore } from "../../lib/schedule-store";
```

Implement the adapter with a store that survives restarts. It must keep these rules:

- Create, list, update, and delete only touch the current tenant's rows.
- `claimDue` atomically leases rows, so overlapping minute runs do not claim the same row.
- `claimDue` checks the schedule's user and destination again before it returns a job.
- `complete` disables one-time rows or computes the next run of a repeating row.
- A row with an expired lease can be claimed again.

Each row runs at least once. A crash after `send` succeeds but before `complete` can run the row again. Tasks with side effects need idempotency in your application. When the destination needs a channel message without another agent turn, use the outbox pattern in [Durable cross-channel notifications](./durable-cross-channel-notifications) instead of `to(...).send(...)`.

## Scheduling instructions

```md title="agent/instructions.md"
Before creating a schedule, confirm the user's time zone and destination.
Convert the first run to ISO 8601 with an explicit offset. Use everyMinutes only
for repeating work and null for a one-time run. List schedules before changing
an ambiguous one.
```

import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Fact } from "eve/events";
import type { defineHook } from "eve/hooks";
import { afterEach, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewOf } from "@tests/helpers/session-view";

let database: PGlite | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await database?.close();
});

it.each(["result", "nothing_to_report"] as const)(
  "finalizes a scheduled browser turn with %s using the production hook and database",
  async (kind) => {
    database = new PGlite();
    const migrations = (await readdir("db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
    for (const filename of migrations) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Apply migrations in journal order.
      const source = await readFile(`db/migrations/${filename}`, "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each migration statement depends on its predecessors.
        if (statement.trim()) await database.exec(statement);
      }
    }
    const localDatabase = drizzle(database, { schema });
    const Database = await import("@db");
    // SAFETY: The test substitutes the owning database driver with the same Drizzle schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite implements the query surface this integration exercises.
    vi.spyOn(Database, "db", "get").mockReturnValue(localDatabase as never);
    const jobs = await import("@db/services/scheduled-agent-jobs");
    const { ensureScope } = await import("@db/services/scope");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const aliceConversation = {
      conversationChannel: "eve" as const,
      conversationId: "main-session",
    };
    await ensureScope(alice);
    const now = new Date("2026-09-01T19:08:00.000Z");
    await jobs.createScheduledAgentJob(
      alice,
      {
        ...aliceConversation,
        missedRunPolicy: "run_latest",
        prompt: "Check the price in the browser.",
        timing: {
          kind: "interval",
          anchoredAt: now.toISOString(),
          everyMinutes: 60,
        },
      },
      new Date(now.getTime() - 60_000)
    );
    await jobs.materializeDueScheduledAgentRuns({ limit: 1, now });
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      limit: 1,
      leaseForMs: 300_000,
      now,
    });
    if (!claim?.run.leaseToken)
      throw new Error("Expected a scheduled worker lease.");
    // A serve task settles in the turn that started it. Exercise the production
    // hook and real database together, including the old call.started boundary.
    const completionHook: Parameters<typeof defineHook>[0] = (
      await import("@agent/hooks/scheduled-run-completion")
    ).default;
    const turnId = "browser-turn";
    const scopeIds = { turnId, runId: "browser-run", taskId: "browser-task" };
    const turnStarted: Extract<Fact, { type: "turn.started" }> = {
      type: "turn.started",
      data: {
        turnId,
        cause: { deliveryId: "delivery-browser" },
        follows: null,
      },
      scope: scopeIds,
    };
    const facts: Fact[] = [
      turnStarted,
      {
        type: "model.requested",
        data: { runId: scopeIds.runId, owner: { turnId } },
        scope: scopeIds,
      },
      {
        type: "call.requested",
        data: {
          callId: "browser-call",
          capability: { kind: "tool", name: "run_browser" },
          input: { message: "Check the price" },
          owner: { runId: scopeIds.runId },
        },
        scope: scopeIds,
      },
    ];
    const context = (eventTime: Date) =>
      hookContextFor({
        sessionId: "replacement-worker-session",
        turnId,
        now: eventTime,
        auth: {
          current: null,
          initiator: {
            authenticator: "scheduled-worker",
            principalId: alice.userId,
            principalType: "user",
            attributes: {
              scheduledRunId: claim.run.id,
              scheduledRunLeaseToken: claim.run.leaseToken,
            },
          },
        },
        view: viewOf(facts.map((fact) => [fact])),
      });
    await completionHook.events["turn.started"]?.(
      turnStarted,
      context(new Date("2026-09-01T19:08:01.000Z"))
    );
    const started: Extract<Fact, { type: "call.started" }> = {
      type: "call.started",
      data: { callId: "browser-call", taskId: scopeIds.taskId },
      scope: scopeIds,
    };
    facts.push(started);
    await completionHook.events["call.started"]?.(
      started,
      context(new Date("2026-09-01T19:08:02.000Z"))
    );
    expect(
      (await jobs.listScheduledAgentJobs(alice, aliceConversation))[0]
        ?.latestRun?.status
    ).toBe("running");
    facts.push(
      {
        type: "call.settled",
        data: {
          callId: "browser-call",
          outcome: "completed",
          output: {
            status: "success",
            images: [],
            message: "The price fell to $250.",
          },
        },
        scope: scopeIds,
      },
      {
        type: "content.completed",
        data: {
          runId: scopeIds.runId,
          partId: "browser-reply",
          kind: "text",
          phase: "reply",
          value: kind === "result" ? "The price fell to $250." : "",
        },
        scope: scopeIds,
      }
    );
    const settled: Extract<Fact, { type: "turn.settled" }> = {
      type: "turn.settled",
      data: { turnId, outcome: "completed", reply: ["browser-reply"] },
      scope: scopeIds,
    };
    facts.push(settled);
    await completionHook.events["turn.settled"]?.(
      settled,
      context(new Date("2026-09-01T19:08:03.000Z"))
    );

    const completed = (
      await jobs.listScheduledAgentJobs(alice, aliceConversation)
    )[0]?.latestRun;
    expect(completed).toMatchObject({
      status: "completed",
      leaseToken: null,
      reportStatus: kind === "result" ? "pending" : "not_needed",
      outcome:
        kind === "result"
          ? { kind, summary: "The price fell to $250." }
          : { kind },
    });
    const report = await jobs.claimScheduledReport(
      claim.run.id,
      new Date("2026-09-01T19:08:04.000Z")
    );
    expect(report !== undefined).toBe(kind === "result");
  },
  20_000
);

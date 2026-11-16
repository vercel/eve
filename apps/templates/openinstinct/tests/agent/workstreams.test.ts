import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type {
  MemoryTurnStartedContext,
  MemoryToolsContext,
  MemoryScopeContext,
} from "eve/memory";
import type { ToolContext } from "eve/tools";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  findWorkstreams,
  forgetWorkstream,
  readWorkstream,
  recallWorkstreams,
  saveWorkstream,
} from "@db/services/workstreams";
import workstreamMemory from "@agent/memory/workstreams";
import {
  saveWorkstreamSchema,
  type WorkstreamContent,
} from "@shared/workstreams/schema";

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "alice", workspaceId: "workspace-alice" };
const bob = { userId: "bob", workspaceId: "workspace-bob" };
const content = {
  title: "Autumn trip",
  objective: "Choose train tickets for the autumn trip.",
  status: "active",
  notes:
    "Window seat. First option departs at 09:00; second at 11:00. Nothing booked.",
  nextStep: "User needs to select a departure.",
  sources: [
    {
      reference: "session:planning",
      observation: "User requested a window seat.",
      observedAt: "2026-09-08T12:00:00Z",
    },
  ],
} satisfies WorkstreamContent;

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

beforeEach(async () => {
  await database.delete(schema.workspaces);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("workstream memory", () => {
  it("recalls an undertaking in a new session and preserves a corrected constraint", async () => {
    const firstContext = context("first");
    const tools = await workstreamMemory.provider.tools(firstContext);
    if (!tools) throw new Error("Expected interactive workstream tools.");
    const first = await tools.save.execute(
      { id: "autumn-trip", expectedRevision: 0, content },
      { ...firstContext, callId: "save", toolName: "workstreams__save" }
    );
    expect(first).toMatchObject({ revision: 1, sessionId: "first" });

    const later = context("later");
    const recall =
      await workstreamMemory.provider.recall["turn.started"](later);
    expect(recall?.messages[0]?.content).toContain("Autumn trip");
    const laterTools = await workstreamMemory.provider.tools(later);
    if (!laterTools) throw new Error("Expected tools in the later session.");
    expect(
      await laterTools.read.execute(
        { id: "autumn-trip" },
        { ...later, callId: "read", toolName: "workstreams__read" }
      )
    ).toMatchObject({ content });
    const corrected = {
      ...content,
      notes:
        "Aisle seat, replacing the window preference. First option departs at 09:00; second at 11:00. Nothing booked.",
    };
    await laterTools.save.execute(
      { id: "autumn-trip", expectedRevision: 1, content: corrected },
      { ...later, callId: "correct", toolName: "workstreams__save" }
    );
    expect(await readWorkstream(alice, "key-a", "autumn-trip")).toMatchObject({
      revision: 2,
      content: corrected,
      sessionId: "later",
    });
    await expect(
      saveWorkstream(
        alice,
        "key-a",
        { id: "autumn-trip", expectedRevision: 1, content },
        "stale",
        "first"
      )
    ).rejects.toThrow("changed");
  });

  it("isolates records by both authenticated workspace and Eve memory scope", async () => {
    await saveWorkstream(
      alice,
      "key-a",
      { id: "autumn-trip", expectedRevision: 0, content },
      "save",
      "first"
    );
    expect(await readWorkstream(bob, "key-a", "autumn-trip")).toBeNull();
    expect(
      await readWorkstream(alice, "preview-key", "autumn-trip")
    ).toBeNull();
    expect((await findWorkstreams(bob, "key-a", {})).items).toEqual([]);
    expect((await recallWorkstreams(alice, "preview-key")).items).toEqual([]);
    await expect(
      saveWorkstream(
        bob,
        "key-a",
        { id: "autumn-trip", expectedRevision: 1, content },
        "overwrite",
        "other"
      )
    ).rejects.toThrow("changed");
    await forgetWorkstream(
      bob,
      "key-a",
      { id: "autumn-trip", expectedRevision: 1 },
      "forget"
    );
    expect(await readWorkstream(alice, "key-a", "autumn-trip")).not.toBeNull();
  });

  it("deduplicates an interrupted save and rejects concurrent stale updates", async () => {
    const input = { id: "autumn-trip", expectedRevision: 0, content };
    const first = await saveWorkstream(
      alice,
      "key-a",
      input,
      "same-call",
      "first"
    );
    expect(
      await saveWorkstream(alice, "key-a", input, "same-call", "first")
    ).toEqual(first);
    const results = await Promise.allSettled([
      saveWorkstream(
        alice,
        "key-a",
        {
          ...input,
          expectedRevision: 1,
          content: { ...content, nextStep: "Check morning fares." },
        },
        "update-a",
        "a"
      ),
      saveWorkstream(
        alice,
        "key-a",
        {
          ...input,
          expectedRevision: 1,
          content: { ...content, nextStep: "Check afternoon fares." },
        },
        "update-b",
        "b"
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(await readWorkstream(alice, "key-a", input.id)).toMatchObject({
      revision: 2,
    });
    await expect(
      saveWorkstream(alice, "key-a", input, "same-call", "first")
    ).rejects.toThrow("changed");
  });

  it("replaces the recalled index after completion, and forgets content without resurrection", async () => {
    await saveWorkstream(
      alice,
      "key-a",
      { id: "autumn-trip", expectedRevision: 0, content },
      "save",
      "first"
    );
    const before = await workstreamMemory.provider.recall["turn.started"](
      context("first")
    );
    await saveWorkstream(
      alice,
      "key-a",
      {
        id: "autumn-trip",
        expectedRevision: 1,
        content: { ...content, status: "completed", nextStep: "" },
      },
      "complete",
      "later"
    );
    const after = await workstreamMemory.provider.recall["turn.started"](
      context("later")
    );
    expect(after?.messages[0]?.id).toBe(before?.messages[0]?.id);
    expect(after?.messages[0]?.content).not.toContain("Autumn trip");
    expect(
      (
        await findWorkstreams(alice, "key-a", {
          query: "autumn",
          status: "completed",
        })
      ).items
    ).toHaveLength(1);
    await expect(
      forgetWorkstream(
        alice,
        "key-a",
        { id: "autumn-trip", expectedRevision: 1 },
        "stale-forget"
      )
    ).rejects.toThrow("changed");
    await forgetWorkstream(
      alice,
      "key-a",
      { id: "autumn-trip", expectedRevision: 2 },
      "forget"
    );
    expect(
      await forgetWorkstream(
        alice,
        "key-a",
        { id: "autumn-trip", expectedRevision: 2 },
        "forget"
      )
    ).toEqual({ forgotten: true });
    expect(await readWorkstream(alice, "key-a", "autumn-trip")).toBeNull();
    expect((await findWorkstreams(alice, "key-a", {})).items).toEqual([]);
    const [tombstone] = await database.select().from(schema.workstreams);
    expect(tombstone).toMatchObject({ content: null, sessionId: null });
    await expect(
      saveWorkstream(
        alice,
        "key-a",
        { id: "autumn-trip", expectedRevision: 0, content },
        "save",
        "first"
      )
    ).rejects.toThrow("forgotten");
  });

  it("fences a delayed initial save when forgetting an ID that is not yet persisted", async () => {
    await expect(
      forgetWorkstream(
        alice,
        "key-a",
        { id: "autumn-trip", expectedRevision: 0 },
        "forget-first"
      )
    ).resolves.toEqual({ forgotten: true });
    await expect(
      saveWorkstream(
        alice,
        "key-a",
        { id: "autumn-trip", expectedRevision: 0, content },
        "delayed-save",
        "first"
      )
    ).rejects.toThrow("forgotten");
    expect(await readWorkstream(alice, "key-a", "autumn-trip")).toBeNull();
    expect((await recallWorkstreams(alice, "key-a")).items).toEqual([]);
    const [tombstone] = await database.select().from(schema.workstreams);
    expect(tombstone).toMatchObject({
      id: "autumn-trip",
      revision: 1,
      content: null,
      sessionId: null,
    });
  });

  it("bounds recall, supports pagination and literal search, and limits retained records", async () => {
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        await saveWorkstream(
          alice,
          "key-a",
          {
            id: `trip-${String(index)}`,
            expectedRevision: 0,
            content: {
              ...content,
              title: `Trip ${String(index)}`,
              notes: index === 0 ? "Discount of 10%_available" : "Regular fare",
            },
          },
          `save-${String(index)}`,
          "first"
        );
      })
    );
    expect(await recallWorkstreams(alice, "key-a")).toMatchObject({
      hasMore: true,
    });
    expect((await recallWorkstreams(alice, "key-a")).items).toHaveLength(8);
    const first = await findWorkstreams(alice, "key-a", {});
    const second = await findWorkstreams(alice, "key-a", {
      offset: first.nextOffset ?? 0,
    });
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(20);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size
    ).toBe(40);
    expect(
      (await findWorkstreams(alice, "key-a", { query: "%_" })).items.map(
        (item) => item.id
      )
    ).toEqual(["trip-0"]);
    await expect(
      saveWorkstream(
        alice,
        "key-a",
        { id: "overflow", expectedRevision: 0, content },
        "overflow",
        "first"
      )
    ).rejects.toThrow("full");
    await forgetWorkstream(
      alice,
      "key-a",
      { id: "trip-0", expectedRevision: 1 },
      "forget"
    );
    await expect(
      saveWorkstream(
        alice,
        "key-a",
        { id: "replacement", expectedRevision: 0, content },
        "replacement",
        "first"
      )
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("disables the slot outside interactive authenticated user turns", async () => {
    expect(workstreamMemory.scope(context("first"))).toBe(alice.workspaceId);
    await Promise.all(
      ["scheduled-worker", "scheduled-result"].map(async (authenticator) => {
        const scheduled = context("scheduled", authenticator);
        expect(workstreamMemory.scope(scheduled)).toBeNull();
        expect(await workstreamMemory.provider.tools(scheduled)).toBeNull();
        expect(
          await workstreamMemory.provider.recall["turn.started"](scheduled)
        ).toBeNull();
      })
    );
    const anonymous = {
      ...context("anonymous"),
      session: { id: "anonymous", auth: { current: null, initiator: null } },
    };
    expect(workstreamMemory.scope(anonymous)).toBeNull();
    expect(await workstreamMemory.provider.tools(anonymous)).toBeNull();
    const unscoped = context("unscoped");
    unscoped.session.auth.current.attributes.workspaceId = "";
    expect(workstreamMemory.scope(unscoped)).toBeNull();
    expect(await workstreamMemory.provider.tools(unscoped)).toBeNull();
    expect(
      await workstreamMemory.provider.recall["turn.started"](unscoped)
    ).toBeNull();
    const runtime = context("worker");
    runtime.session.auth.current.principalType = "runtime";
    expect(workstreamMemory.scope(runtime)).toBeNull();
    expect(await workstreamMemory.provider.tools(runtime)).toBeNull();
  });

  it("rejects oversized content and preserves cancellation", async () => {
    expect(
      saveWorkstreamSchema.safeParse({
        id: "trip",
        expectedRevision: 0,
        content: { ...content, notes: "x".repeat(3_001) },
      }).success
    ).toBe(false);
    const aborted = context("cancelled");
    const controller = new AbortController();
    const reason = new Error("User cancelled.");
    controller.abort(reason);
    await expect(
      workstreamMemory.provider.recall["turn.started"]({
        ...aborted,
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);
  });
});

function context(sessionId: string, authenticator = "authjs") {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "channel:eve", metadata: {} },
    getToken() {
      throw new Error("Token access is outside this test.");
    },
    requireAuth() {
      throw new Error("Auth access is outside this test.");
    },
    async getSandbox() {
      throw new Error("Sandbox access is outside this test.");
    },
    to() {
      throw new Error("Cross-channel delivery is outside this test.");
    },
    memory: {
      scope: {
        key: "key-a",
        namespace: "test-workstreams",
        value: alice.workspaceId,
      },
      slot: "workstreams",
    },
    messages: [],
    operationId: `${sessionId}-recall`,
    session: {
      turn: { id: "turn", sequence: 1 },
      id: sessionId,
      auth: {
        current: {
          attributes: { workspaceId: alice.workspaceId },
          authenticator,
          principalId: alice.userId,
          principalType: "user",
        },
        initiator: null,
      },
    },
    turn: { id: "turn", input: [], sequence: 1 },
  } satisfies MemoryTurnStartedContext &
    MemoryToolsContext &
    MemoryScopeContext &
    Pick<ToolContext, "getToken" | "requireAuth" | "to">;
}

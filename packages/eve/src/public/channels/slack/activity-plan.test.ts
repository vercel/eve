import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import {
  buildSlackActivityRenderers,
  experimental_slackActivityPlan,
} from "#public/channels/slack/activity.js";

const root = {
  id: "root",
  kind: "root-turn" as const,
  rootSessionId: "session",
  rootTurnId: "turn",
};
const worker = {
  id: "worker",
  kind: "subagent" as const,
  name: "researcher",
  parentId: root.id,
  rootSessionId: "session",
  rootTurnId: "turn",
};
const todoAction = {
  id: "todo-action",
  kind: "tool" as const,
  name: "todo",
  parentWorkId: root.id,
  rootTurnId: "turn",
  stepIndex: 0,
};
const searchAction = {
  id: "search-action",
  kind: "tool" as const,
  name: "web_search",
  parentWorkId: worker.id,
  rootTurnId: "turn",
  stepIndex: 1,
};

function todoState(
  sourceEventId: string,
  replacedAt: string,
  value: unknown,
): Extract<
  Parameters<typeof reduceActivityBatch>[1]["events"][number],
  { readonly kind: "state.replaced" }
> {
  return {
    eventId: sourceEventId,
    kind: "state.replaced",
    state: {
      key: "todo",
      parentWorkId: root.id,
      replacedAt,
      rootTurnId: "turn",
      sourceActionId: todoAction.id,
      sourceEventId,
      sourceToolName: "todo",
      value: value as never,
    },
  };
}

describe("Slack activity plan", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders todo state as plan tasks and streams activity under the active task", async () => {
    const requests: Array<{ operation: string; body: URLSearchParams }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const operation = String(url).split("/").at(-1)!;
        requests.push({ operation, body: new URLSearchParams(String(init?.body ?? "")) });
        return Response.json({ ok: true, ts: "1700.1" });
      }),
    );
    const renderer = buildSlackActivityRenderers({
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityPlan()],
    })[0]!;
    const started = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        { eventId: "root", kind: "work.started", startedAt: "1", work: root },
        { eventId: "worker", kind: "work.started", startedAt: "2", work: worker },
        { action: todoAction, eventId: "todo-started", kind: "action.started", startedAt: "3" },
        {
          actionId: todoAction.id,
          eventId: "todo-settled",
          kind: "action.settled",
          outcome: "completed",
          settledAt: "4",
        },
        todoState("todo-state-1", "4", [
          { content: "Inspect the renderer", priority: "high", status: "completed" },
          {
            content: "Implement Slack plan\nwith extra detail",
            priority: "high",
            status: "in_progress",
          },
          { content: "Run checks", priority: "medium", status: "pending" },
        ]),
        { action: searchAction, eventId: "search-started", kind: "action.started", startedAt: "5" },
        {
          actionId: searchAction.id,
          eventId: "search-label",
          kind: "action.label.updated",
          label: "Review Slack plan API",
        },
      ],
      version: 1,
    });

    const state = await renderer.render({
      destination: {
        channelId: "C1",
        installationTeamId: "INSTALL",
        teamId: "TEAM",
        threadTs: "T1",
        triggeringUserId: "USER",
      },
      snapshot: started,
      state: undefined,
    });

    const updated = reduceActivityBatch(started, {
      events: [
        todoState("todo-state-2", "6", [
          { content: "Inspect the renderer", priority: "high", status: "completed" },
          { content: "Implement Slack plan", priority: "high", status: "completed" },
          { content: "Run checks", priority: "medium", status: "in_progress" },
        ]),
        {
          actionId: searchAction.id,
          eventId: "search-done",
          kind: "action.settled",
          outcome: "completed",
          settledAt: "6",
        },
        {
          eventId: "worker-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "7",
          workId: worker.id,
        },
      ],
      version: 1,
    });
    const updatedState = await renderer.render({
      destination: {
        channelId: "C1",
        installationTeamId: "INSTALL",
        teamId: "TEAM",
        threadTs: "T1",
        triggeringUserId: "USER",
      },
      snapshot: updated,
      state,
    });

    const settled = reduceActivityBatch(updated, {
      events: [
        todoState("todo-state-3", "8", [
          { content: "Inspect the renderer", priority: "high", status: "completed" },
          { content: "Implement Slack plan", priority: "high", status: "completed" },
          { content: "Run checks", priority: "medium", status: "completed" },
        ]),
        {
          eventId: "root-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "9",
          workId: root.id,
        },
      ],
      version: 1,
    });
    await renderer.render({
      destination: {
        channelId: "C1",
        installationTeamId: "INSTALL",
        teamId: "TEAM",
        threadTs: "T1",
        triggeringUserId: "USER",
      },
      snapshot: settled,
      state: updatedState,
    });

    expect(requests.map((request) => request.operation)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.update",
    ]);
    expect(requests[0]!.body.get("chunks")).toContain("Inspect the renderer");
    expect(requests[0]!.body.get("chunks")).toContain('"status":"in_progress"');
    expect(requests[0]!.body.get("chunks")).not.toContain("with extra detail");
    expect(requests[1]!.body.get("chunks")).toContain("• researcher\\n");
    expect(requests[1]!.body.get("chunks")).toContain("• Review Slack plan API\\n");
    expect(requests[2]!.body.get("chunks")).toContain("Run checks");
    expect(requests[2]!.body.get("chunks")).toContain("✓ Review Slack plan API\\n");
    expect(requests[5]!.body.get("blocks")).toContain('"title":"Agent plan"');
    expect(requests[5]!.body.get("blocks")).toContain('"status":"complete"');
  });

  it("falls back to the activity hierarchy when no todo state is available", async () => {
    const requests: Array<{ operation: string; body: URLSearchParams }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          body: new URLSearchParams(String(init?.body ?? "")),
          operation: String(url).split("/").at(-1)!,
        });
        return Response.json({ ok: true, ts: "1700.1" });
      }),
    );
    const renderer = buildSlackActivityRenderers({
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityPlan()],
    })[0]!;
    const started = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        { eventId: "root", kind: "work.started", startedAt: "1", work: root },
        { eventId: "worker", kind: "work.started", startedAt: "2", work: worker },
        { action: searchAction, eventId: "search-started", kind: "action.started", startedAt: "3" },
      ],
      version: 1,
    });
    const state = await renderer.render({
      destination: { channelId: "C1", teamId: "TEAM", threadTs: "T1", triggeringUserId: "USER" },
      snapshot: started,
      state: undefined,
    });
    const settled = reduceActivityBatch(started, {
      events: [
        {
          actionId: searchAction.id,
          eventId: "search-done",
          kind: "action.settled",
          outcome: "completed",
          settledAt: "4",
        },
        {
          eventId: "worker-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "5",
          workId: worker.id,
        },
        {
          eventId: "root-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "6",
          workId: root.id,
        },
      ],
      version: 1,
    });
    await renderer.render({
      destination: { channelId: "C1", teamId: "TEAM", threadTs: "T1", triggeringUserId: "USER" },
      snapshot: settled,
      state,
    });

    expect(requests.map((request) => request.operation)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.update",
    ]);
    expect(requests[0]!.body.get("chunks")).toContain("Agent activity");
    expect(requests[0]!.body.get("chunks")).toContain("researcher");
    expect(requests[1]!.body.get("chunks")).toContain("• web_search\\n");
    expect(requests[2]!.body.get("chunks")).toContain("✓ web_search\\n");
    expect(requests[4]!.body.get("blocks")).toContain('"title":"Agent activity"');
    expect(requests[4]!.body.get("blocks")).toContain('"title":"researcher"');
  });
});

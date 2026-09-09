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
const verifier = {
  id: "verifier",
  kind: "subagent" as const,
  name: "verifier",
  parentId: root.id,
  rootSessionId: "session",
  rootTurnId: "turn",
};
const stage = {
  id: "stage",
  kind: "task" as const,
  name: "verify_stage",
  parentId: verifier.id,
  rootSessionId: "session",
  rootTurnId: "turn",
};
const reviewer = {
  id: "reviewer",
  kind: "subagent" as const,
  name: "reviewer",
  parentId: root.id,
  rootSessionId: "session",
  rootTurnId: "turn",
};
const reviewStage = {
  id: "review-stage",
  kind: "task" as const,
  name: "review_stage",
  parentId: reviewer.id,
  rootSessionId: "session",
  rootTurnId: "turn",
};

describe("Slack activity plan", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("streams descendant lifecycle once, then replaces the final plan with top-level work", async () => {
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
      version: 1,
      events: [
        { eventId: "root", kind: "work.started", startedAt: "1", work: root },
        { eventId: "verifier", kind: "work.started", startedAt: "2", work: verifier },
        { eventId: "stage", kind: "work.started", startedAt: "3", work: stage },
        {
          action: {
            id: "verify-action",
            kind: "tool",
            name: "verify",
            parentWorkId: verifier.id,
            rootTurnId: "turn",
            stepIndex: 0,
          },
          eventId: "verify-action",
          kind: "action.started",
          startedAt: "3",
        },
        {
          actionId: "verify-action",
          eventId: "verify-action-label",
          kind: "action.label.updated",
          label: "Verify release",
        },
      ],
    });
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1", teamId: "TEAM", triggeringUserId: "USER" },
      snapshot: started,
      state: undefined,
    });
    const updated = reduceActivityBatch(started, {
      version: 1,
      events: [
        {
          actionId: "verify-action",
          eventId: "verify-action-delta",
          kind: "action.label.updated",
          label: "Verifying tests",
        },
      ],
    });
    const updatedState = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1", teamId: "TEAM", triggeringUserId: "USER" },
      snapshot: updated,
      state,
    });
    const expanded = reduceActivityBatch(updated, {
      version: 1,
      events: [
        { eventId: "reviewer", kind: "work.started", startedAt: "3", work: reviewer },
        { eventId: "review-stage", kind: "work.started", startedAt: "3", work: reviewStage },
      ],
    });
    const expandedState = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1", teamId: "TEAM", triggeringUserId: "USER" },
      snapshot: expanded,
      state: updatedState,
    });
    const settled = reduceActivityBatch(expanded, {
      version: 1,
      events: [
        {
          eventId: "stage-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "4",
          workId: stage.id,
        },
        {
          eventId: "review-stage-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "4",
          workId: reviewStage.id,
        },
        {
          eventId: "verifier-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "5",
          workId: verifier.id,
        },
        {
          eventId: "reviewer-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "5",
          workId: reviewer.id,
        },
        {
          eventId: "root-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "6",
          workId: root.id,
        },
      ],
    });
    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1", teamId: "TEAM", triggeringUserId: "USER" },
      snapshot: settled,
      state: expandedState,
    });
    expect(requests.map((r) => r.operation)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.update",
    ]);
    expect(requests[1]!.body.get("chunks")).toContain("• verify_stage\\n");
    expect(requests[1]!.body.get("chunks")).toContain("• Verify release\\n");
    expect(requests[2]!.body.get("chunks")).toContain("• Verifying tests\\n");
    expect(requests[3]!.body.get("chunks")).toContain('"id":"reviewer"');
    expect(requests[3]!.body.get("chunks")).toContain("• review_stage\\n");
    expect(requests[4]!.body.get("chunks")).toContain("✓ verify_stage\\n");
    expect(requests[4]!.body.get("chunks")).toContain("✓ review_stage\\n");
    expect(requests[6]!.body.get("blocks")).not.toContain("verify_stage");
    expect(requests[6]!.body.get("blocks")).toContain("verifier");
  });
});

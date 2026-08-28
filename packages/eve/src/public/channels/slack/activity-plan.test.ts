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
      ],
    });
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1", teamId: "TEAM", triggeringUserId: "USER" },
      snapshot: started,
      state: undefined,
    });
    const settled = reduceActivityBatch(started, {
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
          eventId: "verifier-done",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "5",
          workId: verifier.id,
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
      state,
    });
    expect(requests.map((r) => r.operation)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.update",
    ]);
    expect(requests[1]!.body.get("chunks")).toContain("• verify_stage\\n");
    expect(requests[2]!.body.get("chunks")).toContain("✓ verify_stage\\n");
    expect(requests[4]!.body.get("blocks")).not.toContain("verify_stage");
    expect(requests[4]!.body.get("blocks")).toContain("verifier");
  });
});

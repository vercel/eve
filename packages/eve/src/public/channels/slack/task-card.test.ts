import { describe, expect, it } from "vitest";

import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

import { renderDefaultSlackTaskCard, withTaskCards } from "./task-card.js";

const turnId = "turn_0";
const scope = { runId: "run_0", turnId };

function harness(audience: "private" | "public" = "private") {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const channel = {
    slack: {
      async request(method: string, body: Record<string, unknown>) {
        requests.push({ body, method });
        return { ok: true, ts: method === "chat.postMessage" ? `ts_${requests.length}` : body.ts };
      },
    },
    state: { audience, channelId: "C1", taskCards: {}, threadTs: "1.0" } as Record<string, unknown>,
  };
  const view = emptySessionView();
  let position = 0;
  const events = withTaskCards({}, renderDefaultSlackTaskCard);
  /** Commits `facts` as the server does, then runs each through the channel with the view after. */
  async function commit(...facts: SessionEvent[]): Promise<SessionView> {
    foldLine(view, { at: `2026-10-13T00:00:${String(10 + position)}.000Z`, facts }, position, {
      retention: "operational",
    });
    await events.committed?.({ facts, position }, { channel, view } as never);
    position += 1;
    return view;
  }
  return { channel, commit, requests };
}

const requested = (callId: string): SessionEvent => ({
  data: {
    callId,
    capability: { kind: "agent", name: "researcher" },
    input: {},
    owner: { runId: "run_0" },
  },
  scope,
  type: "call.requested",
});

const started = (callId: string, taskId: string): SessionEvent[] => [
  {
    data: { kind: "agent", name: "researcher", startedBy: { callId }, taskId },
    type: "task.started",
  },
  { data: { callId, taskId }, scope, type: "call.started" },
];

describe("Slack task cards", () => {
  it("posts a turn's card, updates it as tasks settle, and forgets it once finished", async () => {
    const { channel, commit, requests } = harness();
    await commit(
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    );
    await commit(
      { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
      { data: { owner: { turnId }, runId: "run_0" }, scope, type: "model.requested" },
    );
    await commit(requested("c_1"));
    expect(requests).toEqual([]);
    await commit(...started("c_1", "t_1"));
    expect(requests.map((request) => request.method)).toEqual(["chat.postMessage"]);

    await commit({ data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" });
    await commit({ data: { outcome: "completed", turnId }, type: "turn.settled" });
    await commit({
      data: { callId: "c_1", outcome: "completed", output: "Done. More detail." },
      scope,
      type: "call.settled",
    });
    expect(requests.map((request) => request.method)).toEqual(["chat.postMessage", "chat.update"]);
    expect(JSON.stringify(requests.at(-1)?.body.blocks)).toContain("Done.");
    expect(channel.state.taskCards).toEqual({});
  });

  it("ends a settled card and posts a new one when the turn starts another task", async () => {
    const { commit, requests } = harness();
    await commit(
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    );
    await commit(
      { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
      { data: { owner: { turnId }, runId: "run_0" }, scope, type: "model.requested" },
    );
    await commit(requested("c_1"), ...started("c_1", "t_1"));
    await commit({
      data: { callId: "c_1", outcome: "completed", output: "One." },
      scope,
      type: "call.settled",
    });
    await commit(requested("c_2"), ...started("c_2", "t_2"));
    const ids = (body: Record<string, unknown>) => JSON.stringify(body.blocks).match(/c_\d/g);
    expect(requests.map((request) => [request.method, ids(request.body)])).toEqual([
      ["chat.postMessage", ["c_1"]],
      ["chat.update", ["c_1"]],
      ["chat.update", ["c_1"]],
      ["chat.postMessage", ["c_2"]],
    ]);
    const posts = requests.filter((request) => request.method === "chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[1]?.body.blocks)).not.toContain("c_1");
    expect(JSON.stringify(posts[1]?.body.blocks)).toContain("c_2");
  });

  it("names what a blocked task asks only in a private conversation", async () => {
    const asked = async (audience: "private" | "public") => {
      const { commit, requests } = harness(audience);
      await commit(
        { data: {}, type: "session.started" },
        { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
      );
      await commit(
        { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
        { data: { owner: { turnId }, runId: "run_0" }, scope, type: "model.requested" },
      );
      await commit(
        requested("c_1"),
        ...started("c_1", "t_1"),
        requested("c_2"),
        ...started("c_2", "t_2"),
      );
      await commit({
        data: {
          interactionId: "ask_1",
          request: { kind: "question", prompt: "Which region?" },
          subject: { taskId: "t_1" },
        },
        type: "interaction.opened",
      });
      return JSON.stringify(requests.at(-1)?.body.blocks);
    };
    expect(await asked("private")).toContain("Waiting for a response: Which region?");
    const shared = await asked("public");
    expect(shared).toContain("Waiting for a response");
    expect(shared).not.toContain("Which region?");
  });
});

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { expectReply, scriptedSession } from "./continuation/helpers.ts";

const gate = (marker: string) =>
  `Alice is recording an account change. Call the gate tool exactly once with marker "${marker}".`;
const readStatus = (marker: string) =>
  `Alice is checking her draft. Call the read-status tool exactly once with marker "${marker}". ` +
  "After the tool returns, tell Alice the status from its result.";

// Stub sets are accepted only by the local server `eve eval` starts, so the
// world suites, which run against deployed `--url` targets, exclude this tag.
const TAGS = ["tool-stubs", "local-server"];

export default [
  defineEval({
    description:
      "Tool stubs: an approved stubbed call changes the state a later stubbed read returns.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      // Given a session that uses the gate-ledger stub set.
      const parked = await t.send(gate("ledger-approve-7Q2"), { stubs: "gate-ledger" });
      // Then the gated tool still waits for approval.
      parked.calledTool("gate", { status: "pending", count: 1 });

      // When Alice approves, the stub runs in place of the real tool.
      const approved = await parked.session.respondAll("approve");
      approved.expectOk();
      approved.calledTool("gate", {
        status: "completed",
        output: { marker: "ledger-approve-7Q2", stubbed: true },
        count: 1,
      });

      // Then a later stubbed read in the same session sees the stub's write.
      const read = await approved.session.send(readStatus("ledger-read-7Q2"));
      read.expectOk();
      read.calledTool("read-status", {
        status: "completed",
        output: { ledger: "seeded-marker,ledger-approve-7Q2", status: "stubbed" },
        count: 1,
      });
    },
  }),
  defineEval({
    description: "Tool stubs: an approved dynamic tool runs its stub.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      const parked = await t.send(
        'Alice is widening an access scope. Call the dynamic_scoped_approval tool exactly once with scope "ledger-scope-2P6".',
        { stubs: "gate-ledger" },
      );
      parked.calledTool("dynamic_scoped_approval", { status: "pending", count: 1 });

      const approved = await parked.session.respondAll("approve");
      approved.expectOk();
      approved.calledTool("dynamic_scoped_approval", {
        status: "completed",
        output: { scope: "ledger-scope-2P6", stubbed: true },
        count: 1,
      });
    },
  }),
  defineEval({
    description: "Tool stubs: a denied call never reaches the stub.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      const parked = await t.send(gate("ledger-deny-3K8"), { stubs: "gate-ledger" });
      parked.calledTool("gate", { status: "pending", count: 1 });

      const denied = await parked.session.respondAll("cancel");
      denied.calledTool("gate", { status: "rejected", count: 1 });

      const read = await denied.session.send(readStatus("ledger-after-deny-3K8"));
      read.expectOk();
      read.calledTool("read-status", {
        status: "completed",
        output: { ledger: "seeded-marker" },
        count: 1,
      });
    },
  }),
  defineEval({
    description: "Tool stubs: calling a tool the set does not stub fails the turn.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      const turn = await t.send(readStatus("missing-stub-5H1"), { stubs: "gate-only" });
      turn.calledTool("read-status", { status: "failed", count: 1 });
      turn.event("turn.failed", { data: { code: "TOOL_STUB_MISSING" }, count: 1 });
      turn.notEvent("message.completed");
    },
  }),
  defineEval({
    description: "Tool stubs: an unknown set fails at session create and lists the sets.",
    tags: TAGS,
    async test(t) {
      const error = await t.send("Hello", { stubs: "no-such-set" }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      t.check(
        String(error),
        includes(
          'Unknown tool stub set "no-such-set". Sets in evals/stubs/: gate-ledger, gate-only.',
        ),
      );
    },
  }),
  defineEval({
    description: "Tool stubs: a workflow tool's stub runs in place of its workflow.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      const session = await t.session({ ...scriptedSession, stubs: "gate-ledger" });
      const live = await session.start("Read the draft through a workflow.", scriptedSession);
      const turn = await expectReply(t, live, "Workflow draft status: stubbed-workflow.");
      turn.calledTool("workflow-draft", { status: "completed", count: 1 });
    },
  }),
  defineEval({
    description: "Tool stubs: a workflow tool without a stub fails the turn.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      const session = await t.session({ ...scriptedSession, stubs: "gate-only" });
      const turn = await session.send("Read the draft through a workflow.", scriptedSession);
      turn.event("turn.failed", { data: { code: "TOOL_STUB_MISSING" }, count: 1 });
      turn.notEvent("message.completed");
    },
  }),
  defineEval({
    description: "Tool stubs: eve's ask_question runs as usual when the app mounts it.",
    tags: TAGS,
    timeoutMs: 120_000,
    async test(t) {
      const parked = await t.send(
        'Alice is choosing where to ship. Call the ask_question tool exactly once with question "Where should Alice ship?"',
        { stubs: "gate-only" },
      );
      parked.session.requireInputRequest({ toolName: "ask_question" });
      parked.notEvent("turn.failed");
    },
  }),
];

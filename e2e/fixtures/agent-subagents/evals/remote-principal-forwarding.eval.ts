import { defineEval } from "eve/evals";

const ALICE_PRIVATE_DATA = "ALICE_PRIVATE_DM_7K4M";
const BOB_PRIVATE_DATA = "BOB_PRIVATE_DM_9P2R";
const CHILD_MESSAGE =
  "[forward-auth:child] Call read-private-data exactly once and reply with only its privateData value.";

/** Alice and Bob resume one remote child; each tool call must resolve only its caller's grant. */
export default defineEval({
  tags: ["principal-forwarding", "real-model"],
  description:
    "A persistent remote child resolves credentials only for the caller of the current turn.",
  async test(t) {
    const alice = await t.send(
      [
        "[forward-auth:create] Use remote-loopback exactly once with this message:",
        JSON.stringify(CHILD_MESSAGE),
        "Reply with only the child's output.",
      ].join(" "),
    );
    const called = alice.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "remote-loopback",
    );
    if (called?.type !== "subagent.called") {
      throw new Error("The first turn did not create a remote-loopback child.");
    }
    const childSessionId = called.data.childSessionId;
    const aliceChild = await t.target.watchTurn(childSessionId).result();

    const bob = await t.send(
      [
        "[forward-auth:continue] Continue that same remote-loopback agent using its agentId with this message:",
        JSON.stringify(CHILD_MESSAGE),
        "Reply with only the child's output.",
      ].join(" "),
      { headers: { authorization: "Bearer e2e-principal-forwarding-second-user" } },
    );
    const continued = bob.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "remote-loopback",
    );
    if (continued?.type !== "subagent.called" || continued.data.childSessionId !== childSessionId) {
      throw new Error("Bob did not continue Alice's remote child.");
    }
    const bobChild = await t.target
      .watchTurn(childSessionId, { startIndex: aliceChild.events.length })
      .result();

    aliceChild.calledTool("read-private-data", {
      count: 1,
      output: { privateData: ALICE_PRIVATE_DATA },
      status: "completed",
    });
    bobChild.calledTool("read-private-data", { count: 1 });
    bobChild.calledTool("read-private-data", {
      count: 1,
      output: { privateData: BOB_PRIVATE_DATA },
      status: "completed",
    });

    t.calledSubagent("remote-loopback", { count: 2 });
    t.succeeded();
    t.noFailedActions();
  },
});

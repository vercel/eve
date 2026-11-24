import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "The deployed turn step reports the runtime identity of the agent that ran it.",
  async test(t) {
    const turn = await t.send("Alice is checking which agent answers her. Greet her briefly.");
    t.succeeded();
    turn.event("session.started", { count: 1 });
    const started = turn.events.find((event) => event.type === "session.started");
    const runtime = started?.type === "session.started" ? started.data.runtime : undefined;
    await t.require(
      typeof runtime?.agentId === "string" && runtime.agentId.length > 0,
      equals(true),
    );
    await t.require(
      typeof runtime?.eveVersion === "string" && runtime.eveVersion.length > 0,
      equals(true),
    );
  },
});

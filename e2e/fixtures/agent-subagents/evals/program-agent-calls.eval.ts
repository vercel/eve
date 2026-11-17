import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

const CHILD_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
/** The id the scripted parent gives its `eve__execute` call; nested calls take `<id>/<n>`. */
const PROGRAM_CALL = "program-agent-calls";
// One agent call alone, then two together, then an agent the model can't call. The marker in
// the message selects a scripted parent that runs the program unchanged, so the eval checks how
// eve runs it rather than what a model writes.
const PROGRAM = [
  'const first = await tools["echo-marker"]({ message: "program alpha" });',
  "const pair = await Promise.all([",
  '  tools["echo-marker"]({ message: "program beta" }),',
  '  tools["echo-marker"]({ message: "program gamma" }),',
  "]);",
  "let hidden;",
  "try {",
  '  hidden = await tools["tool-hidden"]({ message: "program delta" });',
  "} catch (error) {",
  "  hidden = error.message;",
  "}",
  "return { hidden, replies: [first, ...pair] };",
].join("\n");

function isProgramOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const { calls, result } = output as {
    readonly calls?: Readonly<Record<string, unknown>>;
    readonly result?: { readonly hidden?: unknown; readonly replies?: unknown };
  };
  const replies = result?.replies;
  return (
    Array.isArray(replies) &&
    replies.length === 3 &&
    replies.every((reply) => typeof reply === "string" && reply.includes(CHILD_TOKEN)) &&
    typeof result?.hidden === "string" &&
    // An agent with `tool: false` isn't in the catalog a program calls from.
    result.hidden.includes('No tool named "tool-hidden"') &&
    calls?.completed === 3 &&
    Object.keys(calls).length === 1
  );
}

/**
 * A program's agent calls on the mock model, so every world runs it: the program parks on each
 * batch of agent calls and resumes with their replies, each call opens a child session it owns,
 * none is a task, and an agent hidden with `tool: false` stays out of reach.
 */
export default defineEval({
  description:
    "A program awaits agent calls one at a time and together: each opens a child session owned by its nested call, none starts a task, and a tool-false agent can't be called.",
  async test(t) {
    const turn = await t.send(
      [
        "E2E_PROGRAM_AGENT_CALLS Alice is checking the echo-marker assistant's replies before a release. She wants one program to ask it three times and to note that the internal specialist is not available to programs.",
        "Run this program unchanged with eve__execute:",
        "",
        "```js",
        PROGRAM,
        "```",
        "",
        "Then reply with what the program returned, as JSON.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool(EXECUTE_TOOL, { count: 1, output: isProgramOutput });
    // Each agent call is reported under the agent's name, as a call of its own.
    t.calledTool("echo-marker", { count: 3, output: /echo-marker-9F2X/u });
    turn.eventsSatisfy("each child session belongs to the nested call that opened it", (events) => {
      const owners = events
        .flatMap((event) =>
          event.type === "child.opened" && event.data.name === "echo-marker"
            ? [JSON.stringify(event.data.owner)]
            : [],
        )
        .sort();
      return (
        JSON.stringify(owners) ===
        JSON.stringify(
          [1, 2, 3].map((index) => JSON.stringify({ callId: `${PROGRAM_CALL}/${index}` })),
        )
      );
    });
    // A program awaits an agent's reply; the model's task table never holds the call.
    turn.notEvent("task.started");
    turn.notEvent("child.opened", { data: { name: "tool-hidden" } });
    t.messageIncludes(CHILD_TOKEN);
    t.noFailedCalls();
  },
});

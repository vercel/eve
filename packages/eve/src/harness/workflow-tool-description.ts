import { DEFAULT_WORKFLOW_MAX_SUBAGENTS } from "#harness/workflow-subagent-limit.js";

/**
 * Builds the model-facing description for the `Workflow` orchestration tool.
 *
 * Dynamic in the agent's callable agents:
 * - lists every callable agent by name (the built-in `agent` plus one per
 *   declared subagent and remote agent);
 * - the worked example uses only the built-in `agent`, so it is valid for any
 *   agent;
 * - a single simple subagent example is appended *only when* the agent has a
 *   declared subagent or remote agent (i.e. an agent other than `agent`).
 *
 * The sandbox package's generated input signatures are appended after this
 * framing.
 *
 * @param toolNames - Names of the agent functions callable inside the sandbox.
 * @param options - `maxSubagents`: the invocation's subagent-call budget
 *   (defaults to {@link DEFAULT_WORKFLOW_MAX_SUBAGENTS}), surfaced so the
 *   model sizes its fan-out to fit.
 */
export function workflowToolDescription(
  toolNames: readonly string[],
  options?: { readonly maxSubagents?: number },
): string {
  const maxSubagents = options?.maxSubagents ?? DEFAULT_WORKFLOW_MAX_SUBAGENTS;
  const agents = toolNames.length > 0 ? toolNames : ["agent"];
  const list = agents.map((name) => `\`${name}\``).join(", ");
  const subagents = agents.filter((name) => name !== "agent");
  const subagentExample =
    subagents.length > 0
      ? `\n\nDeclared subagents use the same API — e.g. \`const note = await ${agentAccess(subagents[0]!)}({ message: "..." });\`.`
      : "";

  return `Use \`Workflow\` when a task needs JavaScript to coordinate multiple child-agent calls as one durable step. It is an orchestration tool, not a general-purpose tool runner.

Use \`Workflow\` for:
- fan-out or map-reduce over a list, especially when the number of calls comes from runtime data;
- dependent pipelines where one agent's result becomes another agent's input;
- conditional branches or follow-up calls chosen from earlier results;
- deterministic filtering, sorting, or aggregation of several agent results before returning one value.

Do not use \`Workflow\` when:
- one delegation, or a small fixed set of unrelated delegations, can be called directly;
- no child-agent call is needed;
- the task needs files, network, shell, connections, skills, or ordinary tools — none are available inside Workflow;
- JavaScript would only wrap work the parent agent can express more clearly with direct calls.

Workflow earns its overhead when code materially controls call count, concurrency, ordering, data flow, or aggregation. Put the complete orchestration in one JavaScript program and return the final JSON-serializable value.

One Workflow program may dispatch at most ${String(maxSubagents)} agent calls in total (sequential and parallel calls alike); calls beyond that budget fail with \`WORKFLOW_SUBAGENT_LIMIT_REACHED\` instead of running. Size fan-outs to fit the budget.

The only callable operations are these agents — no filesystem, network, shell, or other tools: ${list}. Call them only through the \`tools\` object, using the exact member syntax in the API reference below. Each call is async and resolves to the child's result, or a typed object when you pass an \`outputSchema\`. Sequence with \`await\`, run agents concurrently with \`Promise.all([...])\`, and use \`map\`/\`filter\`/\`flatMap\` to build calls and combine results. The program's return value becomes the tool result.

Example — fan out across areas with \`agent\`, then pipe the results into a synthesis step:
\`\`\`js
const areas = ["correctness", "security", "performance"];
const reviews = await Promise.all(
  areas.map((area) =>
    tools.agent({
      message: \`Review the change for \${area}.\`,
      outputSchema: { type: "object", properties: { findings: { type: "array", items: { type: "string" } } } },
    }),
  ),
);
const verdict = await tools.agent({
  message: \`Summarize these findings into a verdict: \${JSON.stringify(reviews)}\`,
  outputSchema: { type: "object", properties: { verdict: { type: "string" }, blocking: { type: "boolean" } } },
});
return verdict;
\`\`\`${subagentExample}`;
}

function agentAccess(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
    ? `tools.${name}`
    : `tools[${JSON.stringify(name)}]`;
}

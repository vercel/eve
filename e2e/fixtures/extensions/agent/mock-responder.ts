import { loadSkills } from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const GIZMO_INSTRUCTIONS_TOKEN = "gizmo-instructions-ok-7K2M";
const JAVASCRIPT_INSTRUCTIONS_TOKEN = "javascript-instructions-ok-9P4R";
const LAYOUT_TOOL = "gizmo__gizmo_layout";

const SKILL_LOAD_DIRECTIVE = "SKILL-LOAD";

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.startsWith(SKILL_LOAD_DIRECTIVE)) {
    return loadSkills(request, message.slice(SKILL_LOAD_DIRECTIVE.length).trim().split(/\s+/u));
  }
  if (message.includes("Report both extension instruction tokens")) {
    const instructions = request.messages
      .filter((entry) => entry.role === "system")
      .map((entry) => entry.text)
      .join("\n");
    return [GIZMO_INSTRUCTIONS_TOKEN, JAVASCRIPT_INSTRUCTIONS_TOKEN]
      .filter((token) => instructions.includes(token))
      .join(" ");
  }

  if (message.includes("Alice is checking the primary account")) {
    const lookups = [
      { name: "toolkit__toolkit_lookup", input: { account: "primary" } },
      { name: "toolkit-alt__toolkit_lookup", input: { account: "secondary" } },
    ];
    const next = lookups.find(
      (lookup) => !request.toolResults.some((result) => result.name === lookup.name),
    );
    return next === undefined
      ? JSON.stringify(request.toolResults.map((result) => result.output))
      : { toolCalls: [next] };
  }

  if (message.includes("Call toolkit__toolkit_lookup")) {
    const calls = [
      "toolkit__toolkit_lookup",
      "toolkit-alt__toolkit_lookup",
      "toolkit__toolkit_budget",
      "toolkit__toolkit_budget",
      "toolkit-alt__toolkit_budget",
    ];
    const completed = request.toolResults;
    const next = calls.find((name, index) => {
      if (name.endsWith("_budget")) {
        const previousBudgetCalls = calls.slice(0, index).filter((call) => call === name).length;
        const completedBudgetCalls = completed.filter((entry) => entry.name === name).length;
        return completedBudgetCalls <= previousBudgetCalls;
      }
      return !completed.some((entry) => entry.name === name);
    });
    return next === undefined
      ? "Both mounts kept their own configuration and budget."
      : {
          toolCalls: [
            {
              name: next,
              input: next.endsWith("_lookup")
                ? { account: next.startsWith("toolkit-alt") ? "secondary" : "primary" }
                : {},
            },
          ],
        };
  }

  if (!message.includes(`Call \`${LAYOUT_TOOL}\``)) {
    return `Mock reply: ${message}`;
  }

  const result = [...request.toolResults].reverse().find((entry) => entry.name === LAYOUT_TOOL);
  if (result === undefined) {
    return { toolCalls: [{ name: LAYOUT_TOOL }] };
  }

  return JSON.stringify(result.output);
}

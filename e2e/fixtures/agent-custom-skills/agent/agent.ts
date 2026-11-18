import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { CHECKLIST, CHECKLIST_V1, CHECKLIST_V2, PERSONA, PERSONA_MARKER } from "./constants.js";

type Output = Record<string, unknown>;

/** The tool result this step continues from, when the previous step called `tool`. */
function justReturned(request: MockModelRequest, tool: string): Output | undefined {
  if (request.messages.at(-1)?.role !== "tool") return undefined;
  const result = request.toolResults.at(-1);
  return result?.name === tool ? (result.output as Output) : undefined;
}

function saveThen(
  request: MockModelRequest,
  input: Record<string, unknown>,
): MockModelResponse | string {
  const saved = justReturned(request, "skills__create");
  if (saved !== undefined) return `SKILL_SAVED:${String(saved.status ?? saved.error)}`;
  return { toolCalls: [{ name: "skills__create", input }] };
}

/**
 * Scripts the world suites' mock model: each eval message names one step of a
 * person's skill workflow, and the model calls the tool a live model would.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const prompt = request.messages.map(({ text }) => text).join("\n");

  if (message.startsWith("Save the sign-off skill")) return saveThen(request, PERSONA);
  if (message.startsWith("Save the release checklist skill")) return saveThen(request, CHECKLIST);
  if (message.startsWith("Save version two of the release checklist")) {
    return saveThen(request, {
      ...CHECKLIST,
      description: CHECKLIST_V2,
      instructions: "Check the build, the changelog, then the rollout plan.",
    });
  }
  if (message.startsWith("Publish version two of the release checklist")) {
    const published = justReturned(request, "skills__publish");
    if (published !== undefined) {
      return `PUBLISHED:${String(published.liveVersion ?? published.error)}`;
    }
    const listed = justReturned(request, "skills__list");
    if (listed === undefined) return { toolCalls: [{ name: "skills__list", input: {} }] };
    const skill = (listed.skills as Output[] | undefined)?.find(
      ({ name }) => name === CHECKLIST.name,
    );
    if (skill === undefined) return "NO_CHECKLIST_TO_PUBLISH";
    return {
      toolCalls: [
        {
          name: "skills__publish",
          input: { name: CHECKLIST.name, id: skill.id, version: 2 },
        },
      ],
    };
  }
  if (message.startsWith("Say hello")) {
    // Always-on skills are in the system prompt, so the model follows them without loading them.
    return prompt.includes(PERSONA.instructions) ? `Hello. ${PERSONA_MARKER}` : "Hello.";
  }
  if (message.startsWith("Which release checklist")) {
    if (prompt.includes(CHECKLIST_V2)) return "CHECKLIST_V2_OFFERED";
    if (prompt.includes(CHECKLIST_V1)) return "CHECKLIST_V1_OFFERED";
    return "NO_CHECKLIST_OFFERED";
  }
  return "CUSTOM_SKILLS_FIXTURE_UNEXPECTED_REQUEST";
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
});

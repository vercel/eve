import { e2eAgentConfig } from "@eve-e2e/config";
import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import { defineAgent, defineDynamic } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { continuationModel } from "./lib/continuation/model.ts";

const AUTH_PROBE_DIRECTIVE = /call the auth-probe tool exactly once with marker "([^"]+)"/iu;
const SCOPED_APPROVAL_DIRECTIVE =
  /call the dynamic_scoped_approval tool exactly once with scope "([^"]+)"/iu;
const REPLY_DIRECTIVE = /reply with exactly ([A-Z0-9-]+)/iu;
const APPROVAL_FOLLOWUP_DIRECTIVE =
  /call the (gate|read-status) tool exactly once with marker "([^"]+)"/iu;
const ASK_QUESTION_DIRECTIVE = /call the ask_question tool exactly once with question "([^"]+)"/iu;
const SCHEDULES_DIRECTIVE =
  /call the (schedules_read|schedules_create) tool exactly once(?: with name "([^"]+)")?/iu;
const SCHEDULER_SUBAGENT_DIRECTIVE = /use the scheduler subagent with message "([^"]+)"/iu;

/**
 * Scripted mock for the world suites: untagged evals in this fixture phrase
 * every prompt as an explicit directive, so the responder executes exactly
 * the requested tool call and replies from its output. A tool message after
 * the latest user message means this turn's call already ran.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";

  const approvalFollowup = APPROVAL_FOLLOWUP_DIRECTIVE.exec(message);
  if (approvalFollowup?.[1] !== undefined && approvalFollowup[2] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
      return {
        toolCalls: [{ name: approvalFollowup[1], input: { marker: approvalFollowup[2] } }],
      };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === approvalFollowup[1])?.output;
    return JSON.stringify(output ?? "Missing tool result");
  }

  // A subagent answers in a later user message, so match the latest directive, not the result.
  const schedulerMessage = [...request.userMessages]
    .reverse()
    .find((entry) => !entry.includes("<task_result"));
  const scheduler = SCHEDULER_SUBAGENT_DIRECTIVE.exec(schedulerMessage ?? "");
  if (scheduler?.[1] !== undefined) {
    const turn = request.userMessages.filter((entry) =>
      SCHEDULER_SUBAGENT_DIRECTIVE.test(entry),
    ).length;
    return playScript(
      request,
      [
        { id: `scheduler-${turn}`, input: () => ({ message: scheduler[1] }), name: "scheduler" },
        { id: `scheduler-${turn}-wait`, name: "task_wait" },
      ],
      (current) => latestTaskResult(current, "scheduler") ?? "Missing scheduler result",
    );
  }

  const schedules = SCHEDULES_DIRECTIVE.exec(message);
  if (schedules?.[1] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
      const input = schedules[2] === undefined ? {} : { name: schedules[2] };
      return { toolCalls: [{ name: schedules[1], input }] };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === schedules[1])?.output;
    return JSON.stringify(output ?? "Missing tool result");
  }

  const reply = REPLY_DIRECTIVE.exec(message);
  if (reply?.[1] !== undefined) {
    return reply[1];
  }

  const scopedApproval = SCOPED_APPROVAL_DIRECTIVE.exec(message);
  if (scopedApproval?.[1] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
      return {
        toolCalls: [{ input: { scope: scopedApproval[1] }, name: "dynamic_scoped_approval" }],
      };
    }
    return `Approved scope: ${scopedApproval[1]}`;
  }

  const askQuestion = ASK_QUESTION_DIRECTIVE.exec(message);
  if (askQuestion?.[1] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
      return {
        toolCalls: [
          {
            input: {
              options: [
                { description: "Ship to the staging environment first.", label: "Staging" },
                { description: "Ship straight to production.", label: "Production" },
              ],
              question: askQuestion[1],
            },
            name: "ask_question",
          },
        ],
      };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === "ask_question")?.output;
    return `ask_question result: ${JSON.stringify(output ?? "")}`;
  }

  const authProbe = AUTH_PROBE_DIRECTIVE.exec(message);
  if (authProbe?.[1] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    const turnHasToolResult = roles.lastIndexOf("tool") > roles.lastIndexOf("user");
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { marker: authProbe[1] }, name: "auth-probe" }] };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === "auth-probe")?.output;
    return `auth-probe result: ${typeof output === "string" ? output : JSON.stringify(output ?? "")}`;
  }

  return `Mock reply: ${message}`;
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  experimental: base.experimental,
  reasoning: "high",
  // Budget evals exhaust this with synthetic usage; ordinary HITL sessions do not.
  limits: { maxOutputTokensPerSession: 1_000_000 },
  model: defineDynamic({
    events: {
      "session.started": () => ({
        model: typeof base.model === "string" ? base.model : "openai/gpt-6-sol",
        modelContextWindowTokens: base.modelContextWindowTokens,
      }),
      "step.started": (_event, ctx) =>
        ctx.session.auth.initiator?.attributes?.model === "continuation"
          ? { model: continuationModel(), modelContextWindowTokens: 1_000_000 }
          : { model: base.model, modelContextWindowTokens: base.modelContextWindowTokens },
    },
  }),
});

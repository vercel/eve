import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { continuationModel } from "./lib/continuation/model.ts";
import { humanInputModel } from "./lib/hitl/model.ts";

const AUTH_PROBE_DIRECTIVE = /call the auth-probe tool exactly once with marker "([^"]+)"/iu;
const SCOPED_APPROVAL_DIRECTIVE =
  /call the dynamic_scoped_approval tool exactly once with scope "([^"]+)"/iu;
const REPLY_DIRECTIVE = /reply with exactly ([A-Z0-9-]+)/iu;
const APPROVAL_FOLLOWUP_DIRECTIVE =
  /call the (gate|read-draft-status) tool exactly once with marker "([^"]+)"/iu;
const ASK_QUESTION_DIRECTIVE = /call the ask_question tool exactly once with question "([^"]+)"/iu;

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

export default defineDynamic({
  experimental: base.experimental,
  reasoning: "high",
  // Budget evals exhaust this with synthetic usage; ordinary HITL sessions do not.
  limits: { maxOutputTokensPerSession: 1_000_000 },
  select: (_view, ctx) => {
    const model = ctx.session.auth.initiator?.attributes?.model;
    return typeof model === "string" ? model : null;
  },
  resolve: (scripted) => {
    switch (scripted) {
      case "continuation":
        return defineAgent({ model: continuationModel(), modelContextWindowTokens: 1_000_000 });
      case "hitl":
        return defineAgent({ model: humanInputModel(), modelContextWindowTokens: 1_000_000 });
      default:
        return defineAgent({
          model: base.model,
          modelContextWindowTokens: base.modelContextWindowTokens,
        });
    }
  },
});

import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { continuationModel } from "./lib/continuation/model.ts";

const AUTH_PROBE_DIRECTIVE = /call the auth-probe tool exactly once with marker "([^"]+)"/iu;
const SCOPED_APPROVAL_DIRECTIVE =
  /call the dynamic_scoped_approval tool exactly once with scope "([^"]+)"/iu;
const REPLY_DIRECTIVE = /reply with exactly ([A-Z0-9-]+)/iu;
const APPROVAL_FOLLOWUP_DIRECTIVE =
  /call the (gate|read-status) tool exactly once with marker "([^"]+)"/iu;

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
        model: typeof base.model === "string" ? base.model : "openai/gpt-5.6-sol",
        modelContextWindowTokens: base.modelContextWindowTokens,
      }),
      "step.started": (_event, ctx) =>
        ctx.session.auth.initiator?.attributes?.model === "continuation"
          ? { model: continuationModel(), modelContextWindowTokens: 1_000_000 }
          : { model: base.model, modelContextWindowTokens: base.modelContextWindowTokens },
    },
  }),
});

import type { DynamicResolveContext } from "#dynamic/definition.js";
import {
  defineAgent,
  defineDynamic,
  type DynamicSentinel,
  type DynamicSubagentDefinition,
} from "eve";

import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { isDeployedRuntime } from "../../../mode.js";
import selfModification from "../../extension.js";

/** Delegates repository changes without exposing coding tools to the parent. */
const deployedSelfModificationAgent: DynamicSentinel<DynamicSubagentDefinition | null> =
  defineDynamic({
    events: {
      "session.started": resolve,
      "turn.started": resolve,
    },
  });

export default deployedSelfModificationAgent;

async function resolve(_event: unknown, ctx: DynamicResolveContext) {
  // In `eve dev`, local self-modification owns delegation.
  if (!isDeployedRuntime()) return null;
  const config = selfModification.config;
  // A throwing policy propagates so the resolver lifecycle logs it and omits the child.
  const allowed = await config.authorize({
    channel: ctx.channel,
    principal: ctx.session.auth.current,
  });
  if (allowed !== true) return null;
  return defineAgent({
    description: [
      "Delegate here when the user asks to investigate or change this eve agent, its tools, skills, instructions, integrations, or other authored source in the configured repository.",
      "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the user does not mention files or source code. For example, replacing a hardcoded weather tool with a live API calls for delegation, not just a one-turn web lookup.",
      "This child has its own sandbox and repository checkout. Your sandbox need not contain the source: do not search your filesystem to decide whether self-modification is available or claim that host-provided tools cannot be changed without consulting this child.",
      "Include exact tool or skill identifiers, the requested behavior, and existing constraints. Do not guess source paths or add unrequested features or implementation steps.",
      "Delegate questions about adding integrations or connecting to named services so the child can inspect the source and search the eve registry rather than guessing availability. Questions, investigations, and design requests are read-only; only an explicit implementation request authorizes source changes and a draft pull request.",
      "Resolve short follow-ups such as 'yes' or 'do it' against the preceding conversation. If persistence or implementation intent is genuinely ambiguous, ask one concise clarifying question. Continue the same child with taskId for follow-ups to an existing task; use a new child for independent requests.",
      "A draft pull request does not change the running agent, even on the next turn. Report the PR, validation, and remaining setup; review, merge, and deployment happen separately. Do not claim an integration is active or call an unchanged tool to verify proposed behavior.",
    ].join(" "),
    model: config.model ?? ctx.model?.id ?? DEFAULT_AGENT_MODEL_ID,
    reasoning: config.reasoning,
  });
}

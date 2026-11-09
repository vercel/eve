import { defineAgent, defineDynamic } from "eve";

import { DEFAULT_AGENT_MODEL_ID, DEFAULT_AGENT_REASONING } from "#shared/default-agent-model.js";

import { hasGitHubCredential } from "../../../credentials.js";
import { isDeployedRuntime } from "../../../mode.js";
import {
  followUpDelegation,
  namedInstallationDelegation,
  persistenceDelegation,
  renderDescription,
  repairDelegation,
  sourceDelegation,
} from "../../../subagent-guidance.js";
import { resolveDeployedSelfModificationConfig } from "../../config.js";
import selfModification from "../../extension.js";

const integrationDelegation =
  "Delegate requests to add integrations, channels, connections, or capabilities: the subagent searches the official eve registry and can install source changes into the draft proposal. Setup may require non-secret answers or an external action, and secret binding remains separate.";

const effectiveEdits =
  "Source edits do not affect the caller’s current turn. The subagent can publish only a draft pull request, and changes become effective only after review, merge, and redeployment.";

const description = renderDescription([
  "Delegate here immediately when the user asks to change this eve agent or its authored source.",
  sourceDelegation,
  persistenceDelegation,
  namedInstallationDelegation,
  integrationDelegation,
  followUpDelegation,
  repairDelegation,
  effectiveEdits,
]);

/** Offers the deployed self-modification child only to authorized principals outside `eve dev`. */
export default defineDynamic(async (ctx) => {
  if (!isDeployedRuntime()) return null;
  const bound = selfModification.config;
  const config = resolveDeployedSelfModificationConfig(bound);
  if (config.credentials.kind === "pat" && !hasGitHubCredential()) return null;
  const principal = ctx.session.auth.current;
  // `authorize` reads the principal's attributes and the channel, so it's asked again each turn.
  const authorized = await ctx.memo(["authorize", principal, ctx.turn?.id ?? null], async () => {
    try {
      return (await config.authorize({ channel: ctx.channel, principal })) === true;
    } catch {
      return false;
    }
  });
  if (!authorized) return null;
  const configuredModel = bound.model ?? ctx.model.id;
  return defineAgent({
    description,
    model: configuredModel ?? DEFAULT_AGENT_MODEL_ID,
    reasoning:
      bound.reasoning ?? (configuredModel === undefined ? DEFAULT_AGENT_REASONING : undefined),
  });
});

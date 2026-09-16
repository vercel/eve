import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { availableDirectModels } from "#internal/model-auth/available-models.js";
import {
  modelKeySecretName,
  readVercelSession,
  writeModelSecret,
  type ModelConnectionSelection,
} from "#internal/model-auth/store.js";
import { resolveModelApiKey } from "#internal/model-auth/transport.js";
import {
  readVercelCliConnection,
  refreshVercelCliConnection,
} from "#internal/model-auth/vercel-cli.js";
import {
  resolveVercelSession,
  validateVercelAccess,
  VERCEL_MODEL_CLIENT_ID,
} from "#internal/model-auth/vercel.js";
import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import type { Prompter } from "#setup/prompter.js";
import { withLoginProgress } from "./model-login-progress.js";
import { validateGatewayApiKey } from "#setup/validate-gateway-key.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";
import { loginVercelModel } from "./vercel-model-login.js";

export const CONNECTION_OPTIONS = [
  { value: "vercel", label: "Vercel Account" },
  { value: "ai-gateway-key", label: "Vercel AI Gateway API Key" },
  { value: "chatgpt", label: "ChatGPT Subscription" },
  { value: "openai", label: "OpenAI API Key" },
  { value: "anthropic", label: "Anthropic API Key" },
] as const;

type Team = { teamId: string; teamName: string };

/** Evidence from this login attempt; credentials stay with their existing owner. */
export interface ValidatedModelConnection {
  selected: ModelConnectionSelection;
  team?: Team;
  availableModels?: string[];
}

export async function reuseModelConnection(
  selected: ModelConnectionSelection,
  team: Team | undefined,
  signal?: AbortSignal,
): Promise<ValidatedModelConnection | undefined> {
  switch (selected) {
    case "chatgpt":
      return (await getDefaultCodexTokenBroker().refreshState()).kind === "ready"
        ? { selected }
        : undefined;
    case "vercel": {
      if (!(await readVercelSession(VERCEL_MODEL_CLIENT_ID))) return undefined;
      const session = await resolveVercelSession();
      team ??= { teamId: session.teamId, teamName: session.teamName };
      await validateVercelAccess(session.accessToken, team.teamId, signal);
      return { selected, team };
    }
    case "vercel-cli": {
      let cli = await readVercelCliConnection();
      if (!cli) return undefined;
      team ??= { teamId: cli.teamId, teamName: cli.teamId };
      try {
        await validateVercelAccess(cli.token, team.teamId, signal);
      } catch {
        signal?.throwIfAborted();
        await refreshVercelCliConnection();
        cli = await readVercelCliConnection();
        if (!cli) return undefined;
        await validateVercelAccess(cli.token, team.teamId, signal);
      }
      return { selected, team };
    }
    case "ai-gateway-project":
      return (await getVercelOidcToken().catch(() => undefined)) ? { selected } : undefined;
    case "ai-gateway-key": {
      const key = await resolveModelApiKey(selected);
      return (await validateGatewayApiKey(key, signal)).kind === "valid" ? { selected } : undefined;
    }
    case "openai":
    case "anthropic":
      return {
        selected,
        availableModels: await availableDirectModels(
          selected,
          await resolveModelApiKey(selected),
          signal,
        ),
      };
  }
}

export async function authenticateModelConnection(input: {
  selected: ModelConnectionSelection;
  team?: Team;
  prompter: Prompter;
  signal?: AbortSignal;
}): Promise<ValidatedModelConnection> {
  const { selected, prompter, signal } = input;
  if (selected === "vercel") {
    return { selected, team: await loginVercelModel(prompter, signal, input.team?.teamId) };
  }
  if (selected === "chatgpt") {
    await ensureChatGptAuth({ signal, log: (message) => prompter.log.info(message) });
    return { selected };
  }
  if (selected === "vercel-cli" || selected === "ai-gateway-project") {
    throw new Error("Choose a connection with /login.");
  }
  const label = CONNECTION_OPTIONS.find((option) => option.value === selected)!.label;
  const key = (
    await prompter.password({
      message: label,
      validate: (value) => (value.trim() ? undefined : "Enter an API key."),
    })
  ).trim();
  const availableModels = await withLoginProgress(prompter, `Checking ${label}…`, async () => {
    if (selected !== "ai-gateway-key") return availableDirectModels(selected, key, signal);
    if ((await validateGatewayApiKey(key, signal)).kind !== "valid") {
      throw new Error(
        "Could not validate the Gateway key. Check the key and your connection, then retry.",
      );
    }
    return undefined;
  });
  signal?.throwIfAborted();
  await writeModelSecret(modelKeySecretName(selected), key);
  return { selected, availableModels };
}

import {
  availableDirectModels as directModels,
  availableHelperModels,
} from "#internal/model-auth/available-models.js";
import { fetchGatewayCatalog } from "../boxes/select-model.js";
import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { inspectApplication } from "#services/inspect-application.js";
import {
  isModelConnection,
  modelKeySecretName,
  readDefaultConnection,
  writeDefaultConnection,
  writeModelSecret,
  type ModelConnectionSelection,
} from "#internal/model-auth/store.js";
import { MODEL_CONNECTION_ENV, resolveModelApiKey } from "#internal/model-auth/transport.js";
import {
  readVercelCliConnection,
  refreshVercelCliConnection,
} from "#internal/model-auth/vercel-cli.js";
import { resolveVercelSession, validateVercelAccess } from "#internal/model-auth/vercel.js";
import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import { MODEL_HELPERS } from "#shared/model-helper.js";
import {
  readProviderSelection,
  readProviderTeamSync,
  readProviderKeySourceSync,
  resolveAvailableProviders,
  writeProviderSelection,
} from "#setup/provider-settings.js";
import type { Prompter } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";
import { validateGatewayApiKey } from "#setup/validate-gateway-key.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";
import { loginVercelModel } from "./vercel-model-login.js";
import { changeAgentModel } from "./model-source-change.js";

const CONNECTION_OPTIONS = [
  { value: "vercel", label: "Vercel Account" },
  { value: "ai-gateway-key", label: "Vercel AI Gateway API Key" },
  { value: "chatgpt", label: "ChatGPT Subscription" },
  { value: "openai", label: "OpenAI API Key" },
  { value: "anthropic", label: "Anthropic API Key" },
] as const;

export function environmentConnection(
  env: Record<string, string | undefined>,
): ModelConnectionSelection | undefined {
  if (env.AI_GATEWAY_API_KEY?.trim()) return "ai-gateway-key";
  if (env.VERCEL_OIDC_TOKEN?.trim()) return "ai-gateway-project";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return undefined;
}

async function connectionReady(
  selected: ModelConnectionSelection,
  signal?: AbortSignal,
): Promise<boolean> {
  switch (selected) {
    case "chatgpt":
      return (await getDefaultCodexTokenBroker().refreshState()).kind === "ready";
    case "vercel": {
      const session = await resolveVercelSession();
      await validateVercelAccess(
        session.accessToken,
        process.env.EVE_MODEL_TEAM ?? session.teamId,
        signal,
      );
      return true;
    }
    case "vercel-cli": {
      let cli = await readVercelCliConnection();
      if (!cli) return false;
      const teamId = process.env.EVE_MODEL_TEAM ?? cli.teamId;
      try {
        await validateVercelAccess(cli.token, teamId, signal);
      } catch {
        signal?.throwIfAborted();
        await refreshVercelCliConnection();
        cli = await readVercelCliConnection();
        if (!cli) return false;
        await validateVercelAccess(cli.token, teamId, signal);
      }
      return true;
    }
    case "ai-gateway-project":
      return Boolean(await getVercelOidcToken().catch(() => undefined));
    case "ai-gateway-key": {
      const key = await resolveModelApiKey("ai-gateway-key");
      if (!key) return false;
      return (await validateGatewayApiKey(key, signal)).kind === "valid";
    }
    case "openai":
    case "anthropic": {
      const key = await resolveModelApiKey(selected);
      if (!key) return false;
      await directModels(selected, key, signal);
      return true;
    }
  }
}

async function applyConnection(input: {
  appRoot: string;
  agentRoot: string;
  selected: ModelConnectionSelection;
  prompter: Prompter;
  signal?: AbortSignal;
  automatic?: boolean;
  availableModels?: string[];
}): Promise<void> {
  const { appRoot, agentRoot, selected, prompter, signal } = input;
  const inspection = await inspectApplication(agentRoot).catch(() => undefined);
  const model = inspection?.compiledState?.manifest.config.model;
  const routing = model?.routing;
  const helper =
    selected === "chatgpt" || selected === "openai" || selected === "anthropic"
      ? selected
      : undefined;
  const compatible = helper
    ? routing?.kind === "external" && routing.provider === MODEL_HELPERS[helper].provider
    : routing?.kind === "gateway";
  const defaultId = helper ? MODEL_HELPERS[helper].defaultModel : "openai/gpt-5.6-luna-fast";
  if (!compatible || model?.id === defaultId) {
    let id: string = defaultId;
    const models =
      input.availableModels ??
      (helper
        ? await availableHelperModels(helper, signal)
        : (await fetchGatewayCatalog(signal))
            .filter((model) => model.type === "language")
            .map((model) => model.id));
    if (!models.includes(id)) {
      if (models.length === 0)
        throw new Error(
          "No models are available for this connection. Choose another connection with /login.",
        );
      id = await prompter.select({
        message: "Choose an available model",
        search: true,
        options: models.map((id) => ({ value: id, label: id })),
      });
    }
    if (!compatible || id !== model?.id) {
      const outcome = await changeAgentModel({
        appRoot: agentRoot,
        slug: helper ? MODEL_HELPERS[helper].prefix + id : id,
      });
      if (outcome.kind === "rejected") throw new Error(outcome.message);
    }
  }
  signal?.throwIfAborted();
  if (selected === "vercel" || selected === "vercel-cli") {
    const credential =
      selected === "vercel" ? await resolveVercelSession() : await readVercelCliConnection();
    if (!credential) throw new Error("Vercel credentials are unavailable. Retry /login.");
    const team = (input.automatic ? readProviderTeamSync(appRoot) : undefined) ?? {
      teamId: credential.teamId,
      teamName: "teamName" in credential ? credential.teamName : credential.teamId,
    };
    await validateVercelAccess(
      "accessToken" in credential ? credential.accessToken : credential.token,
      team.teamId,
      signal,
    );
    await writeProviderSelection(appRoot, selected, team);
    delete process.env.EVE_MODEL_KEY_SOURCE;
    process.env.EVE_MODEL_TEAM = team.teamId;
    process.env.EVE_MODEL_TEAM_NAME = team.teamName;
  } else {
    const keyConnection =
      selected === "openai" || selected === "anthropic" || selected === "ai-gateway-key";
    const keySource = !keyConnection
      ? undefined
      : input.automatic
        ? (readProviderKeySourceSync(appRoot) ??
          (environmentConnection(process.env) === selected ? "environment" : "secret"))
        : "secret";
    await writeProviderSelection(appRoot, selected, undefined, keySource);
    if (keySource) process.env.EVE_MODEL_KEY_SOURCE = keySource;
    else delete process.env.EVE_MODEL_KEY_SOURCE;
    delete process.env.EVE_MODEL_TEAM;
    delete process.env.EVE_MODEL_TEAM_NAME;
  }
  if (!input.automatic) await writeDefaultConnection(selected);
  process.env[MODEL_CONNECTION_ENV] = selected;
}

export async function runModelLogin(input: {
  appRoot: string;
  agentRoot?: string;
  prompter: Prompter;
  automatic?: boolean;
  signal?: AbortSignal;
}): Promise<{ kind: "ready" | "cancelled" }> {
  const { appRoot, prompter, signal } = input;
  const agentRoot = input.agentRoot ?? appRoot;
  try {
    if (input.automatic) {
      const inspection = await inspectApplication(agentRoot).catch(() => undefined);
      const model = inspection?.compiledState?.manifest.config.model;
      if (
        model?.routing.kind === "external" &&
        !Object.values(MODEL_HELPERS).some(
          (spec) => model.routing.kind === "external" && spec.provider === model.routing.provider,
        )
      )
        return { kind: "ready" };
      const authoredHelper = Object.entries(MODEL_HELPERS).find(
        ([, spec]) =>
          model?.routing.kind === "external" && model.routing.provider === spec.provider,
      )?.[0] as "openai" | "anthropic" | "chatgpt" | undefined;
      const existing = (await readProviderSelection(appRoot)) ?? authoredHelper;
      const available = await resolveAvailableProviders(appRoot);
      const selected =
        existing ??
        environmentConnection(process.env) ??
        (available.includes("ai-gateway-project") ? "ai-gateway-project" : undefined) ??
        (await readDefaultConnection()) ??
        "vercel-cli";
      try {
        if (await connectionReady(selected, signal)) {
          await applyConnection({
            appRoot,
            agentRoot,
            selected,
            prompter,
            signal,
            automatic: true,
          });
          return { kind: "ready" };
        }
      } catch (error) {
        signal?.throwIfAborted();
        prompter.log.warning(
          error instanceof Error ? error.message : "Could not connect automatically. Retry /login.",
        );
      }
    }
    while (true) {
      const selected = await prompter.select({
        message: "Connect a model",
        search: true,
        options: [...CONNECTION_OPTIONS],
      });
      if (!isModelConnection(selected)) throw new Error("Choose a model connection.");
      let availableModels: string[] | undefined;
      try {
        if (selected === "chatgpt") {
          await ensureChatGptAuth({ signal, log: (message) => prompter.log.info(message) });
        } else if (selected === "vercel") {
          await loginVercelModel(prompter, signal, readProviderTeamSync(appRoot)?.teamId);
        } else {
          const key = (
            await prompter.password({
              message: CONNECTION_OPTIONS.find((option) => option.value === selected)!.label,
              validate: (value) => (value.trim() ? undefined : "Enter an API key."),
            })
          ).trim();
          await withSpinner(prompter, "Checking connection…", async () => {
            if (selected === "ai-gateway-key") {
              const result = await validateGatewayApiKey(key, signal);
              if (result.kind !== "valid")
                throw new Error(
                  "Could not validate the Gateway key. Check the key and your connection, then retry.",
                );
            } else availableModels = await directModels(selected, key, signal);
          });
          signal?.throwIfAborted();
          await writeModelSecret(modelKeySecretName(selected), key);
        }
        await applyConnection({ appRoot, agentRoot, selected, prompter, signal, availableModels });
        return { kind: "ready" };
      } catch (error) {
        if (error instanceof WizardCancelledError) return { kind: "cancelled" };
        signal?.throwIfAborted();
        prompter.log.warning(
          error instanceof Error ? error.message : "Connection failed. Retry /login.",
        );
      }
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

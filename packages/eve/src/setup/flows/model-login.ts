import { resolveModelEndpointStatus } from "#internal/resolve-model-endpoint-status.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import type { ConnectedModel } from "#shared/model-connection.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { measureLoginStage, withLoginProgress } from "./model-login-progress.js";
import { availableHelperModels } from "#internal/model-auth/available-models.js";
import { fetchGatewayCatalog } from "../boxes/select-model.js";
import { inspectApplication } from "#services/inspect-application.js";
import {
  isModelConnection,
  readDefaultConnection,
  writeDefaultConnection,
  type ModelConnectionSelection,
} from "#internal/model-auth/store.js";
import { MODEL_CONNECTION_ENV } from "#internal/model-auth/transport.js";
import { parseModelHelper, MODEL_HELPERS } from "#shared/model-helper.js";
import {
  readProviderSelection,
  readProviderTeamSync,
  readProviderKeySourceSync,
  resolveAvailableProviders,
  writeProviderSelection,
  providerSettingsMatch,
  type ProviderSettings,
} from "#setup/provider-settings.js";
import type { Prompter } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { changeValidatedAgentModel, readAuthoredModelSelection } from "./model-source-change.js";
import {
  authenticateModelConnection,
  CONNECTION_OPTIONS,
  reuseModelConnection,
  type ValidatedModelConnection,
} from "./model-login-connection.js";

export function environmentConnection(
  env: Record<string, string | undefined>,
): ModelConnectionSelection | undefined {
  if (env.AI_GATEWAY_API_KEY?.trim()) return "ai-gateway-key";
  if (env.VERCEL_OIDC_TOKEN?.trim()) return "ai-gateway-project";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return undefined;
}

interface LoginModel {
  selection?: string;
  external: boolean;
}

async function readLoginModel(agentRoot: string): Promise<LoginModel> {
  const selection = await readAuthoredModelSelection(agentRoot);
  if (selection !== undefined)
    return { selection, external: parseModelHelper(selection) !== undefined };
  // Dynamic models still need routing inspection, but ordinary source literals
  // and eve helpers do not need to compile the agent just to sign in.
  const inspection = await inspectApplication(agentRoot);
  const model = inspection.compiledState?.manifest.config.model;
  return {
    selection:
      model?.routing.kind === "gateway" && model.source === undefined ? model.id : undefined,
    external: model?.routing.kind === "external",
  };
}

function modelSelection(selected: ModelConnectionSelection, model: LoginModel) {
  const helper =
    selected === "chatgpt" || selected === "openai" || selected === "anthropic"
      ? selected
      : undefined;
  const authored = model.selection === undefined ? undefined : parseModelHelper(model.selection);
  const compatible = helper
    ? authored?.helper === helper
    : model.selection !== undefined && !model.external;
  const defaultId = helper ? MODEL_HELPERS[helper].defaultModel : DEFAULT_AGENT_MODEL_ID;
  const currentId = authored?.id ?? model.selection;
  return { helper, compatible, defaultId, needsModels: !compatible || currentId === defaultId };
}

type LoginInput = {
  appRoot: string;
  agentRoot?: string;
  prompter: Prompter;
  automatic?: boolean;
  signal?: AbortSignal;
  /** Applies writes under one watcher lease and waits for runtime activation. */
  withConnectionUpdate?(task: () => Promise<void>): Promise<void>;
};

export type ModelLoginResult =
  | { kind: "ready"; reload: boolean; model?: ConnectedModel }
  | { kind: "cancelled" };

async function applyConnection(
  input: LoginInput,
  connection: ValidatedModelConnection,
  model: LoginModel,
  models: string[] | undefined,
): Promise<ModelLoginResult> {
  const { appRoot, prompter, signal } = input;
  const { selected, team } = connection;
  const { helper, compatible, defaultId, needsModels } = modelSelection(selected, model);
  let slug: string | undefined;
  if (needsModels) {
    const available =
      connection.availableModels ??
      models ??
      (helper
        ? await withLoginProgress(prompter, "Loading available models…", () =>
            availableHelperModels(helper, signal),
          )
        : []);
    let id = defaultId;
    if (!available.includes(id)) {
      if (available.length === 0)
        throw new Error(
          "No models are available for this connection. Choose another connection with /login.",
        );
      id = await prompter.select({
        message: "Choose an available model",
        search: true,
        options: available.map((id) => ({ value: id, label: id })),
      });
    }
    const next = helper ? MODEL_HELPERS[helper].prefix + id : id;
    if (!compatible || next !== model.selection) slug = next;
  }
  const keyConnection =
    selected === "openai" || selected === "anthropic" || selected === "ai-gateway-key";
  const keySource = !keyConnection
    ? undefined
    : input.automatic
      ? (readProviderKeySourceSync(appRoot) ??
        (environmentConnection(process.env) === selected ? "environment" : "secret"))
      : "secret";
  const settings: ProviderSettings = { selected, ...team, keySource };
  const settingsChanged = !(await providerSettingsMatch(appRoot, settings));
  const save = async () => {
    signal?.throwIfAborted();
    if (slug !== undefined) {
      const outcome = await changeValidatedAgentModel({
        appRoot: input.agentRoot ?? appRoot,
        slug,
      });
      if (outcome.kind === "rejected") throw new Error(outcome.message);
    }
    if (settingsChanged) await writeProviderSelection(appRoot, selected, team, keySource);
    process.env[MODEL_CONNECTION_ENV] = selected;
    if (keySource) process.env.EVE_MODEL_KEY_SOURCE = keySource;
    else delete process.env.EVE_MODEL_KEY_SOURCE;
    if (team) {
      process.env.EVE_MODEL_TEAM = team.teamId;
      process.env.EVE_MODEL_TEAM_NAME = team.teamName;
    } else {
      delete process.env.EVE_MODEL_TEAM;
      delete process.env.EVE_MODEL_TEAM_NAME;
    }
  };
  if (slug !== undefined) {
    await withLoginProgress(prompter, "Loading selected model…", () =>
      measureLoginStage("activation", () =>
        input.withConnectionUpdate ? input.withConnectionUpdate(save) : save(),
      ),
    );
  } else await save();
  if (!input.automatic) await writeDefaultConnection(selected);
  const selection = slug ?? model.selection;
  const id = helper && selection ? parseModelHelper(selection)?.id : selection;
  let connectedModel: ConnectedModel | undefined;
  if (id) {
    const routing = helper
      ? { kind: "external" as const, provider: MODEL_HELPERS[helper].provider }
      : classifyModelRouting(id);
    connectedModel = {
      id,
      routing,
      endpoint: resolveModelEndpointStatus(
        routing,
        {
          apiKey: selected === "ai-gateway-key",
          oidc: selected === "ai-gateway-project",
          account: selected === "vercel" || selected === "vercel-cli",
          team: team?.teamName,
        },
        { state: "ready" },
      ),
    };
  }
  return {
    kind: "ready",
    reload: slug !== undefined && input.withConnectionUpdate === undefined,
    ...(connectedModel && { model: connectedModel }),
  };
}

export async function runModelLogin(input: LoginInput): Promise<ModelLoginResult> {
  const { appRoot, prompter, signal } = input;
  let modelPromise: Promise<LoginModel> | undefined;
  const getModel = () =>
    (modelPromise ??= measureLoginStage("source_inspection", () =>
      readLoginModel(input.agentRoot ?? appRoot),
    ));

  const connect = async (
    selected: ModelConnectionSelection,
    automatic: boolean,
  ): Promise<ModelLoginResult | undefined> => {
    const controller = new AbortController();
    const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // Public catalog work can overlap browser sign-in. Capture its failure so
    // it cannot abandon an active prompt or become an unhandled rejection.
    const preparation = getModel()
      .then(async (model) => {
        const selection = modelSelection(selected, model);
        const models =
          !selection.helper && selection.needsModels
            ? (await measureLoginStage("gateway_catalog", () => fetchGatewayCatalog(attemptSignal)))
                .filter((model) => model.type === "language")
                .map((model) => model.id)
            : undefined;
        return { model, models };
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      const team = readProviderTeamSync(appRoot);
      const connection = await measureLoginStage("authentication", async () =>
        automatic
          ? await withLoginProgress(prompter, "Checking model access…", () =>
              reuseModelConnection(selected, team, attemptSignal),
            )
          : await authenticateModelConnection({ selected, team, prompter, signal: attemptSignal }),
      );
      if (!connection) return undefined;
      const prepared = await withLoginProgress(
        prompter,
        "Loading available models…",
        () => preparation,
      );
      if ("error" in prepared) throw prepared.error;
      return await applyConnection(
        { ...input, automatic, signal: attemptSignal },
        connection,
        prepared.value.model,
        prepared.value.models,
      );
    } finally {
      controller.abort();
    }
  };

  try {
    if (input.automatic) {
      const { model, selected } = await withLoginProgress(
        prompter,
        "Reading saved connection…",
        async () => {
          const [model, existing, available, machineDefault] = await Promise.all([
            getModel(),
            readProviderSelection(appRoot),
            resolveAvailableProviders(appRoot),
            readDefaultConnection(),
          ]);
          const authoredHelper =
            model.selection === undefined ? undefined : parseModelHelper(model.selection)?.helper;
          return {
            model,
            selected:
              existing ??
              authoredHelper ??
              environmentConnection(process.env) ??
              (available.includes("ai-gateway-project") ? "ai-gateway-project" : undefined) ??
              machineDefault ??
              ("vercel-cli" as const),
          };
        },
      );
      if (model.external && model.selection === undefined) return { kind: "ready", reload: false };
      try {
        const result = await connect(selected, true);
        if (result) return result;
      } catch (error) {
        modelPromise = undefined;
        signal?.throwIfAborted();
        prompter.log.warning(
          error instanceof Error ? error.message : "Could not connect automatically. Retry /login.",
        );
      }
    }
    while (true) {
      const selected = await prompter.select({
        message: "Choose a connection",
        search: true,
        options: [...CONNECTION_OPTIONS],
      });
      if (!isModelConnection(selected)) throw new Error("Choose a model connection.");
      try {
        const result = await connect(selected, false);
        if (result) return result;
      } catch (error) {
        modelPromise = undefined;
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

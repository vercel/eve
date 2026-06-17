import { join } from "node:path";

import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { inspectApplication } from "#services/inspect-application.js";
import { createStaticSourceChange } from "#source-change/static-source-change.js";

import pc from "picocolors";

import { interactiveAsker } from "../ask.js";
import { findEnvFileWithKey } from "../boxes/detect-ai-gateway.js";
import {
  fetchGatewayCatalog,
  selectModel,
  type SelectModelDeps,
  type SelectModelOptions,
} from "../boxes/select-model.js";
import { detectProjectIdentity, type ProjectDetectionOptions } from "../project-resolution.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import type { Prompter, SelectNotice, SelectOption } from "../prompter.js";
import { runInteractive } from "../runner.js";
import { snapshotSetupState } from "../state.js";
import { WizardCancelledError } from "../step.js";

import { inProjectSetupState, prompterSink } from "./in-project.js";
import { runVercelFlow } from "./vercel.js";

/** The current model id, its routing, and whether `/model` can rewrite it. */
export interface CurrentAgentModel {
  id: string | null;
  routing: ModelRouting | null;
  /**
   * The authored `model` is a string the source editor can rewrite. False for a
   * source-backed SDK model call (`gateway(...)`, `anthropic(...)`), which is
   * not a string literal — independent of how the model routes.
   */
  editable: boolean;
}

/** Injected for tests; defaults to the real reads, fetches, and source edit. */
export interface ModelFlowDeps {
  /**
   * Reads the model the runtime currently serves and how it routes; both null
   * before the first compile.
   */
  readCurrentModel: (appRoot: string) => Promise<CurrentAgentModel>;
  /** Applies the picked slug to authored source. */
  applyModel: (input: { appRoot: string; slug: string }) => Promise<ApplyModelOutcome>;
  /** Catalog fetch behind the shared model picker. */
  selectModel?: SelectModelDeps;
  /** Reads how the model is backed right now, for the menu's provider row. */
  detectProviderStatus: typeof detectModelProviderStatus;
  /** The provider sub-flow behind the menu's provider row. */
  runVercelFlow: typeof runVercelFlow;
}

/**
 * How the agent's model is backed right now, as far as the local directory
 * shows: a linked Vercel project, a gateway credential in an env file, or
 * nothing detectable. An external provider (own ANTHROPIC_API_KEY etc.)
 * leaves no marker eve owns, so it reads as `unset`.
 */
export type ModelProviderStatus =
  | { kind: "unset" }
  | { kind: "gateway-project"; projectName: string; teamName?: string }
  | {
      kind: "gateway-key";
      envKey: "AI_GATEWAY_API_KEY" | "VERCEL_OIDC_TOKEN";
      envFile: string;
    };

/**
 * A provider sub-flow run that actually moved the provider: the credential
 * the link flow verified landed in an env file (when one did), paired with
 * the re-detected {@link ModelProviderStatus} — the same read the menu's
 * provider row shows, so every surface reports one truth. The sub-flow's
 * external-provider branch only shows instructions — nothing changes on
 * disk — so it never surfaces as an outcome.
 */
export interface ModelProviderOutcome {
  credential?: "VERCEL_OIDC_TOKEN" | "AI_GATEWAY_API_KEY";
  status: ModelProviderStatus;
}

export type ModelFlowResult =
  | { kind: "cancelled" }
  | {
      kind: "done";
      /** The last apply line, when the model was changed this session. */
      modelMessage?: string;
      /** The last provider sub-flow outcome, when one ran to completion. */
      providerOutcome?: ModelProviderOutcome;
    };

// The bordered panel's title ("Configure the agent model") is the menu's header,
// so the select itself carries no message — avoiding a redundant second title.
export const MODEL_MENU_MESSAGE = "";

type ModelMenuRow = "model" | "provider" | "done";

/**
 * The provider row's value line. `emphasis` bolds the project and team names
 * for the menu (the stacked hint line renders embedded bold safely); the
 * plain form feeds notice and outcome copy.
 */
function providerStatusHint(
  provider: Exclude<ModelProviderStatus, { kind: "unset" }>,
  emphasis: (text: string) => string = (text) => text,
): string {
  if (provider.kind === "gateway-project") {
    const where =
      provider.teamName === undefined
        ? emphasis(provider.projectName)
        : `${emphasis(provider.projectName)} in ${emphasis(provider.teamName)}`;
    return `AI Gateway (Linked to ${where})`;
  }
  return `AI Gateway (${provider.envKey} in ${provider.envFile})`;
}

/**
 * The two-row configure menu. The two rows answer independent questions.
 *
 * The model row keys off `editable`: eve can rewrite `model` only when it is a
 * string literal, so an SDK model call (`gateway(...)` / `anthropic(...)`) is
 * disabled regardless of how it routes. The provider row keys off routing: an
 * external endpoint disables it (gateway credentials don't apply); a gateway
 * endpoint gates it bold-yellow "Configure provider" until a link or credential
 * is detectable (the genuine "no provider connected" state), then "Change
 * provider" naming it.
 */
function modelMenuRows(
  current: string | null,
  provider: ModelProviderStatus,
  routing: ModelRouting | null,
  editable: boolean,
): SelectOption<ModelMenuRow>[] {
  let modelRow: SelectOption<ModelMenuRow>;
  if (editable) {
    modelRow = { value: "model", label: "Change model" };
    if (current !== null) modelRow.hint = current;
  } else {
    modelRow = {
      value: "model",
      label: "Change model",
      disabled: true,
      description: "Set via an SDK model call in agent.ts; edit the source to change it",
    };
  }

  let providerRow: SelectOption<ModelMenuRow>;
  if (routing?.kind === "external") {
    providerRow = {
      value: "provider",
      label: "Change provider",
      disabled: true,
      description: "Disabled in external endpoint mode",
    };
  } else if (provider.kind === "unset") {
    providerRow = {
      value: "provider",
      // The label's own color covers every glyph, so it holds whether or not
      // the cursor row's accent wrap is around it. `accent: "warning"` turns the
      // cursor pointer yellow to match.
      label: pc.bold(pc.yellow("Configure provider")),
      hint: "Required to enable the agent",
      accent: "warning",
    };
  } else {
    providerRow = {
      value: "provider",
      label: "Change provider",
      hint: providerStatusHint(provider, pc.bold),
    };
  }

  // An explicit exit row, like the channels list — Esc works too, but the menu
  // must not make Esc the only way out.
  return [modelRow, providerRow, { value: "done", label: "Done" }];
}

/**
 * Reads the provider status the menu shows. Detection order matters: a linked
 * project subsumes any pulled credential (the link is what the user manages),
 * and `AI_GATEWAY_API_KEY` outranks `VERCEL_OIDC_TOKEN` because it is the one
 * the provider sub-flow's own-key branch writes.
 */
export async function detectModelProviderStatus(
  appRoot: string,
  options: ProjectDetectionOptions = {},
): Promise<ModelProviderStatus> {
  const [identity, gatewayKeyFile, oidcFile] = await Promise.all([
    detectProjectIdentity(appRoot, options),
    findEnvFileWithKey(appRoot, "AI_GATEWAY_API_KEY"),
    findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
  ]);
  if (identity !== undefined) {
    const status: ModelProviderStatus = {
      kind: "gateway-project",
      projectName: identity.projectName,
    };
    if (identity.teamName !== undefined) status.teamName = identity.teamName;
    return status;
  }
  if (gatewayKeyFile !== undefined) {
    return { kind: "gateway-key", envKey: "AI_GATEWAY_API_KEY", envFile: gatewayKeyFile };
  }
  if (oidcFile !== undefined) {
    return { kind: "gateway-key", envKey: "VERCEL_OIDC_TOKEN", envFile: oidcFile };
  }
  return { kind: "unset" };
}

/**
 * THE MODEL FLOW for the dev TUI's `/model`: a two-row action menu that
 * loops, uniting the model pick and the provider setup behind one entry
 * point. "Change model" runs the same searchable AI Gateway catalog picker
 * onboarding uses ({@link selectModel}), pre-selected on the model the
 * runtime currently serves, then the static source edit that bakes the
 * choice into `agent.ts` (activation is the dev server's HMR watcher).
 * The provider row runs {@link runVercelFlow} — the provider gate (AI
 * Gateway or your own), then link-or-paste-a-key.
 * Completed model and provider changes return to the prompt with their result.
 * Cancelled flows and external-provider instructions return to the menu.
 */
export async function runModelFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<ModelFlowDeps>;
}): Promise<ModelFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ModelFlowDeps = {
    readCurrentModel: readCurrentAgentModel,
    applyModel: changeAgentModel,
    detectProviderStatus: detectModelProviderStatus,
    runVercelFlow,
    ...input.deps,
  };

  async function checkProject<T>(task: () => Promise<T>): Promise<T> {
    const spinner = prompter.log.spinner?.("Checking the project…");
    try {
      return await task();
    } finally {
      spinner?.stop();
    }
  }

  // The model read is local, the provider status is a `vercel` round-trip;
  // one ephemeral spinner covers both so the menu paints with no persisted
  // loading lines.
  const detectProvider = (): Promise<ModelProviderStatus> =>
    deps.detectProviderStatus(appRoot, { signal });
  let [{ id: current, routing, editable }, provider] = await checkProject(() =>
    Promise.all([deps.readCurrentModel(appRoot), detectProvider()]),
  );
  signal?.throwIfAborted();

  let lastApply: ApplyModelOutcome | undefined;
  let providerOutcome: ModelProviderOutcome | undefined;
  // Explains, once, why every row is inert for an external-provider model.
  const externalNotice: SelectNotice | undefined =
    routing?.kind === "external"
      ? {
          tone: "warning",
          text: "`agent.ts` specifies a model provider directly. In-TUI configuration is restricted to AI Gateway endpoints.",
        }
      : undefined;

  // Start at the first useful row. Cancellation keeps the current row.
  let nextSelection: ModelMenuRow =
    provider.kind === "unset" && routing?.kind !== "external"
      ? "provider"
      : editable
        ? "model"
        : routing?.kind === "external"
          ? "done"
          : "provider";

  while (true) {
    let pick: ModelMenuRow;
    try {
      pick = await prompter.select<ModelMenuRow>({
        message: MODEL_MENU_MESSAGE,
        options: modelMenuRows(current, provider, routing, editable),
        hintLayout: "stacked",
        initialValue: nextSelection,
        notices: externalNotice === undefined ? [] : [externalNotice],
      });
    } catch (error) {
      if (!(error instanceof WizardCancelledError)) throw error;
      break;
    }

    if (pick === "done") break;

    if (pick === "model") {
      const slug = await pickModelFromCatalog({
        appRoot,
        prompter,
        current,
        signal,
        deps: deps.selectModel,
      });
      if (slug === undefined) {
        nextSelection = "model";
        continue;
      }
      signal?.throwIfAborted();
      lastApply = await deps.applyModel({ appRoot, slug });
      signal?.throwIfAborted();
      break;
    }

    const result = await deps.runVercelFlow({ appRoot, prompter, signal });
    signal?.throwIfAborted();
    // Backing out of the provider sub-flow changed nothing; the cursor stays on
    // the provider row so a retry is one keypress away.
    if (result.kind === "cancelled") {
      nextSelection = "provider";
      continue;
    }
    // External-provider setup only shows instructions, so keep the menu open.
    if ("outcome" in result) {
      nextSelection = "done";
      continue;
    }
    // Only a completed link/own-key sub-flow can move the link or
    // credentials, so this is the one place the status is re-read.
    provider = await checkProject(detectProvider);
    signal?.throwIfAborted();
    providerOutcome = { status: provider };
    if (result.credential !== undefined) providerOutcome.credential = result.credential;
    break;
  }

  if (lastApply === undefined && providerOutcome === undefined) {
    return { kind: "cancelled" };
  }
  const done: Extract<ModelFlowResult, { kind: "done" }> = { kind: "done" };
  if (lastApply !== undefined) done.modelMessage = formatApplyModelOutcome(lastApply);
  if (providerOutcome !== undefined) done.providerOutcome = providerOutcome;
  return done;
}

/**
 * The "Change model" sub-flow: the shared catalog picker pre-selected on
 * `current`. Resolves to the picked slug, or undefined when cancelled —
 * the menu loop treats both as "back to the menu".
 */
async function pickModelFromCatalog(input: {
  appRoot: string;
  prompter: Prompter;
  current: string | null;
  signal?: AbortSignal;
  deps?: SelectModelDeps;
}): Promise<string | undefined> {
  const { appRoot, prompter, current, signal } = input;
  const baseFetch = input.deps?.fetchModels ?? fetchGatewayCatalog;
  const options: SelectModelOptions = {
    asker: interactiveAsker(prompter),
    deps: {
      // The box fetches inside its gather, so the catalog spinner has to ride
      // the fetch itself to bracket exactly the slow part.
      fetchModels: async (requestSignal) => {
        const spinner = prompter.log.spinner?.("Loading the model catalog...");
        try {
          return await baseFetch(requestSignal);
        } finally {
          spinner?.stop();
        }
      },
    },
  };
  if (current !== null) options.defaultModel = current;

  const result = await runInteractive(
    [selectModel(options)],
    inProjectSetupState(appRoot, { kind: "unresolved" }),
    prompterSink(prompter),
    { snapshot: snapshotSetupState, signal },
  );
  return result.kind === "cancelled" ? undefined : result.state.modelId;
}

/** The outcome of applying a model slug to the agent's authored source. */
export type ApplyModelOutcome =
  | { kind: "changed"; to: string }
  | { kind: "unchanged"; model: string }
  /** Invalid slug or an uneditable source — `message` says which and why. */
  | { kind: "rejected"; message: string };

/** The one-line transcript form of an apply outcome (`/model <slug>`'s reply). */
export function formatApplyModelOutcome(outcome: ApplyModelOutcome): string {
  switch (outcome.kind) {
    case "changed":
      return `Model changed to ${pc.bold(outcome.to)}. Live on your next prompt.`;
    case "unchanged":
      return `Model is already \`${outcome.model}\`.`;
    case "rejected":
      return outcome.message;
  }
}

/**
 * Applies a `/model <slug>` change to the local agent's authored source.
 *
 * This is the caller layer for the static source-change registry: it
 * validates the slug against the AI Gateway model catalog, then edits
 * `agent.ts` via {@link createStaticSourceChange}. Activation is the dev
 * server's HMR watcher; {@link formatApplyModelOutcome} renders the outcome
 * as the TUI's one-line reply.
 */
export async function changeAgentModel(input: {
  readonly appRoot: string;
  readonly slug: string;
}): Promise<ApplyModelOutcome> {
  const { appRoot, slug } = input;

  const rejection = await validateModelSlug(appRoot, slug);
  if (rejection !== null) {
    return { kind: "rejected", message: rejection };
  }

  const agentRoot = join(appRoot, "agent");
  const { manifest } = await discoverAgent({ agentRoot, appRoot });
  const result = await createStaticSourceChange(manifest).updateModelName(slug);

  if (result.kind === "bail") {
    return {
      kind: "rejected",
      message: `Couldn't edit ${result.at.logicalPath}: ${result.reason}. Change \`model\` by hand.`,
    };
  }
  if (result.from === result.to) {
    return { kind: "unchanged", model: result.to };
  }
  return { kind: "changed", to: result.to };
}

/**
 * Returns a rejection message when `slug` is malformed or absent from the
 * model catalog, or null when it is safe to apply.
 *
 * UX note: `/model` only reports success after eve confirms the id. A real
 * turn still needs Gateway/provider access, so treating an offline catalog as
 * success would give a false "model changed" result.
 */
async function validateModelSlug(appRoot: string, slug: string): Promise<string | null> {
  if (!slug.includes("/")) {
    return `\`${slug}\` isn't a provider/model id (e.g. anthropic/claude-sonnet-4.6).`;
  }

  const catalog = createCompiledRuntimeModelCatalogLoader(appRoot);
  try {
    const limits = await catalog.getModelLimits(formatLanguageModelGatewayId(slug));
    if (limits === null) {
      return `I couldn't confirm \`${slug}\` in the AI Gateway model catalog, so I didn't change agent.ts.`;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Reads the model the runtime is currently serving. That's the compiled
 * `config.model.id`, the same field `eve info` reports. Returns null when the
 * app hasn't compiled yet.
 */
async function readCurrentAgentModel(appRoot: string): Promise<CurrentAgentModel> {
  try {
    const { compiledState } = await inspectApplication(appRoot);
    const model = compiledState?.manifest.config.model;
    // A source-backed model (an SDK model call) carries `source`; a string id
    // does not, and only a string is a literal the editor can rewrite.
    return {
      id: model?.id ?? null,
      routing: model?.routing ?? null,
      editable: model !== undefined && model.source === undefined,
    };
  } catch {
    return { id: null, routing: null, editable: false };
  }
}

/**
 * Refusal message when `/model` can't rewrite the model — it is a source-backed
 * SDK model call (`gateway(...)`, `anthropic(...)`), not a string literal — or
 * null when the model is an editable string. Editability is independent of
 * routing: a `gateway(...)` call is gateway-routed yet still uneditable here.
 */
export async function modelChangeRefusalForUneditableModel(
  appRoot: string,
): Promise<string | null> {
  const { editable, routing } = await readCurrentAgentModel(appRoot);
  if (editable) {
    return null;
  }
  const detail =
    routing?.kind === "external"
      ? `the external provider \`${routing.provider}\``
      : "an SDK model call";
  return `Model is set via ${detail} in agent.ts, not a string literal; /model can't rewrite it. Edit \`model\` in agent.ts.`;
}

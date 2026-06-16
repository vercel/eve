import { fetchGatewayModelIds } from "../gateway-models.js";
import type { SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

/**
 * What the gather decided to validate. `model: null` means nothing to
 * validate: interactive runs pick from the gateway-backed catalog already.
 */
export interface PreflightInput {
  /** Model id to validate against the AI Gateway catalog, or null to skip. */
  model: string | null;
}

/** Injected for tests; defaults to the real AI Gateway catalog read. */
export interface PreflightDeps {
  fetchGatewayModelIds: typeof fetchGatewayModelIds;
}

export interface PreflightOptions {
  /** Directory to run `vercel` from: the project's parent (it does not exist yet). */
  cwd: string;
  /**
   * Headless mode: only a headless `--model` needs catalog validation, so the
   * gather derives a model to check from state. Interactive runs pick from the
   * gateway-backed catalog and validate nothing. The box prompts for nothing,
   * so this dispatch comes from the composition site, not from a question.
   */
  headless?: boolean;
  deps?: PreflightDeps;
}

/**
 * THE PREFLIGHT BOX: fails fast on an unknown `--model` BEFORE any filesystem
 * scaffolding, so a bad flag never leaves a half-provisioned project on disk.
 * Only a headless `--model` needs the gateway round-trip, so the interactive
 * gather yields a no-op input. The scaffold bakes a gateway-format model id
 * on every wiring (the `byok` block routes through the Gateway too), so the
 * check applies regardless of how credentials are wired. Team validation
 * lives in the resolve-provisioning box.
 */
export function preflight(options: PreflightOptions): SetupBox<SetupState, PreflightInput, null> {
  const deps = options.deps ?? { fetchGatewayModelIds };

  return {
    id: "preflight",

    async gather({ state }): Promise<PreflightInput> {
      // Interactive runs pick from the gateway-backed catalog, so there is
      // nothing to validate; a headless `--model` is checked on every wiring.
      if (!options.headless) return { model: null };
      return { model: state.modelId.length > 0 ? state.modelId : null };
    },

    async perform({ input }): Promise<null> {
      if (input.model !== null) {
        await validateModel(deps, input.model, options.cwd);
      }
      return null;
    },

    apply(state) {
      return state;
    },
  };
}

async function validateModel(deps: PreflightDeps, model: string, cwd: string): Promise<void> {
  const ids = await deps.fetchGatewayModelIds(cwd);
  // Null = catalog unreachable; don't block creation on the network.
  if (ids === null || ids.has(model)) return;
  throw new Error(
    `Model "${model}" is not in the AI Gateway catalog. Pass a model id from ` +
      "https://ai-gateway.vercel.sh/v1/models (e.g. anthropic/claude-sonnet-4.6).",
  );
}

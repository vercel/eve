import type { AgentDefinition } from "eve";
import { mockModel, type MockModelResponder } from "eve/evals";

/**
 * Sentinel value for `EVE_E2E_MODEL` that makes fixtures author a
 * deterministic `mockModel()` instead of a real gateway model. The world
 * suites (Vercel, Postgres) set it so infrastructure coverage never depends
 * on live model behavior.
 */
export const MOCK_MODEL_SENTINEL = "mock";

const DEFAULT_MODEL = "openai/gpt-5.6-sol";

// Mock models carry no AI Gateway metadata, so mock-mode configs must state a
// context window explicitly for the compiler. Fixtures that need a specific
// window override it after the spread.
const MOCK_MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Harness-owned agent configuration shared by e2e fixture root agents. */
export type E2EAgentConfig = Pick<
  AgentDefinition,
  "experimental" | "model" | "modelContextWindowTokens"
>;

/** Harness-owned configuration for fixture subagents: model identity only. */
export type E2ESubagentConfig = Pick<AgentDefinition, "model" | "modelContextWindowTokens">;

/**
 * A static model handle: a gateway model id string or a deterministic mock
 * instance. Assignable anywhere fixtures author a non-dynamic model
 * (agent `model`, compaction `model`, dynamic fallbacks, subagents).
 */
export type E2EModel = string | ReturnType<typeof mockModel>;

/** Options for {@link e2eAgentConfig} and {@link e2eModel}. */
export interface E2EModelOptions {
  /**
   * Responder (or static reply) used when the harness requests mock models
   * via `EVE_E2E_MODEL=mock`. Defaults to a deterministic echo of the last
   * user message.
   */
  readonly mock?: MockModelResponder | string;
}

/**
 * Resolves the model a fixture agent (or subagent) should author:
 * `EVE_E2E_MODEL=mock` yields a deterministic `mockModel()`, any other value
 * is used as a gateway model id, and the harness default applies when unset.
 */
export function e2eModel(options?: E2EModelOptions): E2EModel {
  const requested = process.env.EVE_E2E_MODEL;

  if (requested === MOCK_MODEL_SENTINEL) {
    return mockModel(options?.mock ?? defaultMockResponder);
  }

  return requested ?? DEFAULT_MODEL;
}

/**
 * Returns the harness-owned configuration shared by e2e fixture root agents:
 * the matrix model from `EVE_E2E_MODEL` (or a mock when the world suite
 * requests one) and the workflow world override from `EVE_E2E_WORKFLOW_WORLD`.
 */
export function e2eAgentConfig(options?: E2EModelOptions): E2EAgentConfig {
  const base = e2eSubagentConfig(options);
  const workflowWorld = process.env.EVE_E2E_WORKFLOW_WORLD;
  if (workflowWorld === undefined) {
    return base;
  }

  return { ...base, experimental: { workflow: { world: workflowWorld } } };
}

/**
 * Returns the harness-owned configuration for fixture subagents: the matrix
 * model (or a mock plus its explicit context window in the world suites),
 * without root-only settings like the workflow world.
 */
export function e2eSubagentConfig(options?: E2EModelOptions): E2ESubagentConfig {
  const model = e2eModel(options);

  if (typeof model === "string") {
    return { model };
  }

  return { model, modelContextWindowTokens: MOCK_MODEL_CONTEXT_WINDOW_TOKENS };
}

/**
 * Resolves the judge model for a fixture's `evals.config.ts`. Judge
 * assertions only run in the model suite, so the mock sentinel falls back to
 * the harness default rather than leaking `"mock"` as a gateway model id.
 */
export function e2eJudgeModel(): string {
  const requested = process.env.EVE_E2E_MODEL;

  if (requested === undefined || requested === MOCK_MODEL_SENTINEL) {
    return DEFAULT_MODEL;
  }

  return requested;
}

const defaultMockResponder: MockModelResponder = ({ lastUserMessage }) =>
  `Mock reply: ${lastUserMessage ?? ""}`;

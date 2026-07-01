/**
 * Model the repository's eval fixtures use by default. Centralized so a single
 * edit re-points every fixture that imports it; fixtures that intentionally
 * pin a different model (e.g. deterministic mocks) keep their own value.
 */
export const DEFAULT_EVAL_MODEL = "anthropic/claude-sonnet-5";

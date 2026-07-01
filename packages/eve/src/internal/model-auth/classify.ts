import type { ModelAuth, ModelRouting } from "#shared/agent-definition.js";

/**
 * Derives the credential contract for a model from its compile-time routing.
 *
 * Codex auth is never derived here: it is an explicit opt-in via
 * `experimental.useCodexSubscription`, applied by the compiler.
 */
export function classifyModelAuth(routing: ModelRouting): ModelAuth {
  if (routing.kind === "gateway") {
    return { kind: "ai-gateway" };
  }
  return { kind: "external", provider: routing.provider };
}

export function cloneModelAuth(auth: ModelAuth): ModelAuth {
  switch (auth.kind) {
    case "ai-gateway":
      return { kind: "ai-gateway" };
    case "codex":
      return { kind: "codex" };
    case "external":
      return { kind: "external", provider: auth.provider };
  }
}

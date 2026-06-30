import { isCodexProvider } from "#internal/codex-model-catalog.js";
import type { ModelAuth, ModelRouting } from "#shared/agent-definition.js";

export function modelAuthForRouting(routing: ModelRouting): ModelAuth {
  if (routing.kind === "gateway") {
    return { kind: "ai-gateway" };
  }
  if (isCodexProvider(routing.provider)) {
    return { kind: "codex" };
  }
  return { kind: "external", provider: routing.provider };
}

export function classifyModelAuth(routing: ModelRouting): ModelAuth {
  return cloneModelAuth(modelAuthForRouting(routing));
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

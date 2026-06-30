import type { ModelAuth, ModelRouting } from "#shared/agent-definition.js";

export interface ModelAuthAdapter {
  readonly auth: ModelAuth;
}

export class AIGatewayAuth implements ModelAuthAdapter {
  readonly auth = { kind: "ai-gateway" } as const satisfies ModelAuth;
}

export class CodexAuth implements ModelAuthAdapter {
  readonly auth = { kind: "codex" } as const satisfies ModelAuth;
}

class ExternalModelAuth implements ModelAuthAdapter {
  readonly auth: ModelAuth;

  constructor(provider: string) {
    this.auth = { kind: "external", provider };
  }
}

const aiGatewayAuth = new AIGatewayAuth();
const codexAuth = new CodexAuth();

function isCodexProvider(provider: string): boolean {
  return provider.split(".")[0] === "codex";
}

export function modelAuthAdapterForRouting(routing: ModelRouting): ModelAuthAdapter {
  if (routing.kind === "gateway") {
    return aiGatewayAuth;
  }
  if (isCodexProvider(routing.provider)) {
    return codexAuth;
  }
  return new ExternalModelAuth(routing.provider);
}

export function classifyModelAuth(routing: ModelRouting): ModelAuth {
  return cloneModelAuth(modelAuthAdapterForRouting(routing).auth);
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

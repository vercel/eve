import {
  defineSandbox,
  type RuntimeSandboxSession,
  type SandboxSelectorContext,
} from "#public/definitions/sandbox.js";
import { defineSandboxProvider } from "#public/sandbox/provider.js";
import { bindSandboxEnvironment } from "#shared/sandbox-environment.js";

const DisabledSelfModificationSandbox = defineSandboxProvider({
  name: "self-modification-disabled",
  environment: () => ({
    onSessionEnd: async () => {},
    prepare: async () => ({}),
    resume: async () => {
      throw new Error("Self-modification sandbox is disabled in this environment.");
    },
    start: async () => {
      throw new Error("Self-modification sandbox is disabled in this environment.");
    },
  }),
});

export function createDisabledSelfModificationSandbox(): (
  context: SandboxSelectorContext,
) => Promise<RuntimeSandboxSession> | RuntimeSandboxSession {
  const environment = DisabledSelfModificationSandbox.environment();
  return bindSandboxEnvironment(
    defineSandbox(() => environment.open()),
    environment,
  );
}

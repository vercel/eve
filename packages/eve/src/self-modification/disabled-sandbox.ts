import { defineSandbox } from "#public/definitions/sandbox.js";
import { defineSandboxProvider } from "#public/sandbox/provider.js";
import { bindSandboxEnvironment, type SandboxSelector } from "#shared/sandbox-environment.js";

const unavailable = async (): Promise<never> => {
  throw new Error("Self-modification sandbox is disabled in this environment.");
};

const disabledEnvironment = defineSandboxProvider({
  name: "self-modification-disabled",
  environment: () => ({
    onSessionEnd: async () => {},
    prepare: async () => ({}),
    resume: unavailable,
    start: unavailable,
  }),
}).environment();

export function createDisabledSelfModificationSandbox(): SandboxSelector {
  return bindSandboxEnvironment(
    defineSandbox(() => disabledEnvironment.open()),
    disabledEnvironment,
  );
}

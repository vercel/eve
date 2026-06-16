import type * as CodeModeModule from "#compiled/experimental-ai-sdk-code-mode/index.js";

/** Internal AI SDK tool name used for eve's code-mode wrapper. */
export const CODE_MODE_TOOL_NAME = "code_mode";

/**
 * Model-facing tool name for eve's `Workflow` orchestration wrapper — a
 * code-mode sandbox restricted to subagent and remote-agent calls. Reserved so
 * authored tools cannot collide with it.
 */
export const WORKFLOW_TOOL_NAME = "Workflow";

const CODE_MODE_MODULE_KEY = Symbol.for("eve.codeMode.module");
const CODE_MODE_MODULE_SPECIFIER = ["#compiled", "experimental-ai-sdk-code-mode", "index.js"].join(
  "/",
);

type CodeModeModuleNamespace = typeof CodeModeModule;

type CodeModeGlobal = typeof globalThis & {
  [CODE_MODE_MODULE_KEY]?: CodeModeModuleNamespace;
};

let codeModeModulePromise: Promise<CodeModeModuleNamespace> | undefined;

export type {
  CodeModeApprovalInterrupt,
  CodeModeInterrupt,
  CodeModeInterruptExecutionContext,
  CodeModeInterruptPayload,
  CodeModeOptions,
} from "#compiled/experimental-ai-sdk-code-mode/index.js";

/**
 * Reads the `EVE_EXPERIMENTAL_CODE_MODE` backstop. Per-agent
 * `experimental.codeMode` takes precedence; this env var is the
 * fallback applied to agents that do not set the flag.
 */
export function isCodeModeEnvEnabled(
  env: { readonly [name: string]: string | undefined } = process.env,
): boolean {
  return env.EVE_EXPERIMENTAL_CODE_MODE === "1";
}

/**
 * Resolves the effective code-mode setting for one agent. The authored
 * `experimental.codeMode` flag wins; when omitted, eve falls back to the
 * {@link isCodeModeEnvEnabled} environment backstop.
 */
export function resolveCodeModeEnabled(
  experimentalCodeMode: boolean | undefined,
  env: { readonly [name: string]: string | undefined } = process.env,
): boolean {
  return experimentalCodeMode ?? isCodeModeEnvEnabled(env);
}

export function installCodeModeModule(module: CodeModeModuleNamespace): void {
  (globalThis as CodeModeGlobal)[CODE_MODE_MODULE_KEY] = module;
}

export async function loadCodeModeModule(): Promise<CodeModeModuleNamespace> {
  const installed = (globalThis as CodeModeGlobal)[CODE_MODE_MODULE_KEY];
  if (installed !== undefined) {
    return installed;
  }

  codeModeModulePromise ??= importCodeModeModule(CODE_MODE_MODULE_SPECIFIER);
  return await codeModeModulePromise;
}

async function importCodeModeModule(specifier: string): Promise<CodeModeModuleNamespace> {
  return (await import(specifier)) as CodeModeModuleNamespace;
}

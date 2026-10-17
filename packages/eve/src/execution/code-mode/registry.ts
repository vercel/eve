import { JavaScriptProgramRuntime } from "./javascript.js";
import type { ProgramLanguage, ProgramRuntime } from "./runtime.js";

const runtimes = new Map<ProgramLanguage, ProgramRuntime>([["js", new JavaScriptProgramRuntime()]]);

/** Registers an interpreter without changing the language-neutral driver. */
export function registerProgramRuntime(runtime: ProgramRuntime): void {
  runtimes.set(runtime.language, runtime);
}

export function getProgramRuntime(language: ProgramLanguage): ProgramRuntime {
  const runtime = runtimes.get(language);
  if (runtime === undefined)
    throw new Error(`Code-mode language "${language}" is not available: no runtime is registered.`);
  return runtime;
}

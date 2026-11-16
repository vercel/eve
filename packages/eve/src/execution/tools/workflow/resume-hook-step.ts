import { resumeHookWherever } from "#execution/tools/workflow/resume-hook.js";

/** Resumes a hook wherever it's held, as a step on Workflow, so the runtime API stays out of the owner. */
export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  await resumeHookWherever(token, payload, options);
}

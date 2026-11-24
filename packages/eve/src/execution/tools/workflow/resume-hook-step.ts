import { processApp } from "#runtime/app.js";
import { resumeHookWherever } from "#execution/tools/workflow/resume-hook.js";

export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  await resumeHookWherever(processApp().hosts, token, payload, options);
}

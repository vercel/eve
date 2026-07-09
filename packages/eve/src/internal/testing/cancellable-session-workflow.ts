import type { HookPayload } from "#channel/types.js";
import { createHook } from "#compiled/@workflow/core/index.js";

export async function cancellableSessionWorkflow(token: string): Promise<void> {
  "use workflow";

  const cancellationHook = createHook<HookPayload>({ token });
  const holdHook = createHook<HookPayload>({ token: `${token}:hold` });

  try {
    await cancellationHook;
    await holdHook;
  } finally {
    await Promise.all([cancellationHook.dispose(), holdHook.dispose()]);
  }
}

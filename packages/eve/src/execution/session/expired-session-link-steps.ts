import { getWorld } from "#internal/workflow/runtime.js";

/** Whether the World keeps a hook findable after its run ends and lets a later run replace it. */
export async function supportsExpiredSessionLinksStep(): Promise<boolean> {
  "use step";
  const { capabilities } = await getWorld();
  return capabilities?.hookForceClaim === true && capabilities.hookRetention?.active === true;
}

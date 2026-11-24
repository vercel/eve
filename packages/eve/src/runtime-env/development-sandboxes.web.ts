import type { ensureDevelopmentSandboxesPrepared as NodeTwin } from "./development-sandboxes.js";

export const ensureDevelopmentSandboxesPrepared: typeof NodeTwin = async () => {
  throw new Error("A browser has no development build whose sandboxes could be prepared.");
};

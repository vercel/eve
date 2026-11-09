import type { ensureDevelopmentSandboxesPrepared as NodeTwin } from "./development-sandboxes.js";

// A browser has no development build on disk, so a sandbox there never asks for one: its compiled
// artifacts are never a disk source. `development-sandboxes.ts` is the Node twin.

export const ensureDevelopmentSandboxesPrepared: typeof NodeTwin = async () => {
  throw new Error("A browser has no development build whose sandboxes could be prepared.");
};

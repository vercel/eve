import { createHash } from "node:crypto";
import { FACTORY_BRAIN_PREFIX } from "./blob.js";
import { FACTORY_REPO } from "./constants.js";

/**
 * Key derivation and size bound for the shared factory brain.
 *
 * @remarks
 * The brain lives under the reserved `factory-brain/` prefix, owned by the `read_factory_brain`
 * and `update_factory_brain` tools (only trusted callers may write). The prefix and its guards
 * come from the reserved-namespace registry in `./blob.js`, which is what keeps any
 * general-purpose Blob tool from using the namespace as a side channel to read or overwrite the
 * shared brain.
 */

/**
 * Maximum size of the factory-brain document, in characters.
 *
 * @remarks
 * The brain is a short, curated set of durable notes about the target repository, not a
 * transcript of every run. The bound keeps it small and cheap to load into context at the start
 * of every task.
 */
export const MAX_FACTORY_BRAIN_LENGTH = 40_000;

/**
 * Resolve the Blob key holding the factory brain for the target repository.
 *
 * @remarks
 * The key is derived entirely from {@link FACTORY_REPO} (resolved at module load), never from
 * model input or a caller's principal, so every session on one deployment reads and writes the
 * same shared document. Keying on the target repository scopes the brain to the code it
 * describes: a single-repo deployment has exactly one brain, and a deployment that later targets
 * another repository gets a separate brain rather than mixing facts across codebases. The
 * repository slug is hashed so the stored path carries no raw `owner/repo` in the object name.
 *
 * @returns The reserved Blob key for this factory's brain.
 */
export const factoryBrainKey = (): string => {
  const id = createHash("sha256").update(FACTORY_REPO).digest("hex");
  return `${FACTORY_BRAIN_PREFIX}${id}.md`;
};

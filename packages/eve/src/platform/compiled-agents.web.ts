import type {
  compiledSessionAgent as NodeCompiledSessionAgent,
  loadCompiledBundle as NodeLoadCompiledBundle,
  loadCompiledManifest as NodeLoadCompiledManifest,
  loadCompiledSessionAgent as NodeLoadCompiledSessionAgent,
} from "./compiled-agents.js";

// A browser has no compiled artifacts to read, so an agent compiled from files can't run here: a
// page defines its agent in code. `compiled-agents.ts` is the Node twin.

function refuse(): never {
  throw new Error(
    "An agent compiled from files runs only on a Node host; in a browser, define the agent in code.",
  );
}

export const loadCompiledManifest: typeof NodeLoadCompiledManifest = async () => refuse();
export const loadCompiledBundle: typeof NodeLoadCompiledBundle = async () => refuse();
export const compiledSessionAgent: typeof NodeCompiledSessionAgent = async () => refuse();
export const loadCompiledSessionAgent: typeof NodeLoadCompiledSessionAgent = async () => refuse();

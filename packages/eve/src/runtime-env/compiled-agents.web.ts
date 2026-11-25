import type {
  compiledSessionAgent as NodeCompiledSessionAgent,
  loadCompiledBundle as NodeLoadCompiledBundle,
  loadCompiledManifest as NodeLoadCompiledManifest,
  loadCompiledSessionAgent as NodeLoadCompiledSessionAgent,
} from "./compiled-agents.js";

interface CompiledAgentLoader {
  readonly loadCompiledManifest: typeof NodeLoadCompiledManifest;
  readonly loadCompiledBundle: typeof NodeLoadCompiledBundle;
  readonly compiledSessionAgent: typeof NodeCompiledSessionAgent;
  readonly loadCompiledSessionAgent: typeof NodeLoadCompiledSessionAgent;
}

const LOADER_KEY = Symbol.for("eve.compiled-agent-loader");

function refuse(): never {
  throw new Error(
    "An agent compiled from files runs only on a Node host; in a browser, define the agent in code.",
  );
}

function installedLoader(): CompiledAgentLoader | undefined {
  return (globalThis as { [LOADER_KEY]?: CompiledAgentLoader })[LOADER_KEY];
}

export const loadCompiledManifest: typeof NodeLoadCompiledManifest = async (...args) => {
  const loader = installedLoader();
  return loader === undefined ? refuse() : await loader.loadCompiledManifest(...args);
};

export const loadCompiledBundle: typeof NodeLoadCompiledBundle = async (...args) => {
  const loader = installedLoader();
  return loader === undefined ? refuse() : await loader.loadCompiledBundle(...args);
};

export const compiledSessionAgent: typeof NodeCompiledSessionAgent = async (...args) => {
  const loader = installedLoader();
  return loader === undefined ? refuse() : await loader.compiledSessionAgent(...args);
};

export const loadCompiledSessionAgent: typeof NodeLoadCompiledSessionAgent = async (...args) => {
  const loader = installedLoader();
  return loader === undefined ? refuse() : await loader.loadCompiledSessionAgent(...args);
};

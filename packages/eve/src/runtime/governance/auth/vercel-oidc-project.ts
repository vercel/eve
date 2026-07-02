import type { CurrentVercelProject } from "#runtime/governance/auth/types.js";

type VercelOidcProjectResolver = () =>
  | CurrentVercelProject
  | undefined
  | Promise<CurrentVercelProject | undefined>;

const VERCEL_OIDC_PROJECT_RESOLVERS = Symbol.for("eve.vercel-oidc-project-resolvers");

type VercelOidcProjectResolverGlobal = typeof globalThis & {
  [VERCEL_OIDC_PROJECT_RESOLVERS]?: WeakMap<Request, VercelOidcProjectResolver>;
};

const globalResolverRegistry = globalThis as VercelOidcProjectResolverGlobal;

if (globalResolverRegistry[VERCEL_OIDC_PROJECT_RESOLVERS] === undefined) {
  globalResolverRegistry[VERCEL_OIDC_PROJECT_RESOLVERS] = new WeakMap();
}

const projectResolvers = globalResolverRegistry[VERCEL_OIDC_PROJECT_RESOLVERS];

/**
 * Binds the current local project only to one request. The global symbol makes
 * the binding visible to both Nitro-inlined and disk-imported eve modules.
 */
export async function withVercelOidcProjectResolver<T>(
  input: {
    readonly request: Request;
    readonly resolveCurrentProject: VercelOidcProjectResolver;
  },
  callback: () => Promise<T> | T,
): Promise<T> {
  const previous = projectResolvers.get(input.request);
  projectResolvers.set(input.request, input.resolveCurrentProject);
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      projectResolvers.delete(input.request);
    } else {
      projectResolvers.set(input.request, previous);
    }
  }
}

export async function resolveVercelOidcCurrentProject(
  request: Request,
): Promise<CurrentVercelProject | undefined> {
  const resolver = projectResolvers.get(request);
  return resolver === undefined ? undefined : await resolver();
}

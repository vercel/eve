export interface EvePublicRouteMount {
  readonly publicPath: string;
  readonly routePath: string;
}

function joinRoutePrefix(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function normalizePublicRoute(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`eve Next.js public route ${JSON.stringify(path)} must start with "/".`);
  }
  if (path === "/eve/v1" || path.startsWith("/eve/v1/")) {
    throw new Error(
      `eve Next.js public route ${JSON.stringify(path)} is already covered by the eve protocol mount.`,
    );
  }
  if (path === "/" || path.endsWith("/")) {
    throw new Error(
      `eve Next.js public route ${JSON.stringify(path)} must identify a non-root route without a trailing slash.`,
    );
  }

  const parameterNames = new Set<string>();
  for (const segment of path.slice(1).split("/")) {
    if (/^[A-Za-z0-9._~-]+$/.test(segment)) continue;
    const name = segment.startsWith(":") ? segment.slice(1) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `eve Next.js public route ${JSON.stringify(path)} has unsupported segment ${JSON.stringify(segment)}. Use URL-safe literal segments or ":name" parameters.`,
      );
    }
    if (parameterNames.has(name)) {
      throw new Error(
        `eve Next.js public route ${JSON.stringify(path)} repeats parameter ${JSON.stringify(name)}.`,
      );
    }
    parameterNames.add(name);
  }
  return path;
}

export function createEvePublicRouteMounts(input: {
  readonly publicRoutePrefix: string;
  readonly publicRoutes: readonly string[];
}): readonly EvePublicRouteMount[] {
  return [...new Set(input.publicRoutes.map(normalizePublicRoute))].sort().map((routePath) => ({
    publicPath:
      input.publicRoutePrefix.length === 0
        ? routePath
        : joinRoutePrefix(input.publicRoutePrefix, routePath),
    routePath,
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRoutePath(
  path: string,
): readonly { readonly name?: string; readonly value: string }[] {
  return normalizePublicRoute(path)
    .split("/")
    .slice(1)
    .map((segment) =>
      segment.startsWith(":") ? { name: segment.slice(1), value: segment } : { value: segment },
    );
}

export function createVercelRouteSource(path: string): string {
  const segments = parseRoutePath(path).map((segment) =>
    segment.name === undefined ? escapeRegExp(segment.value) : `(?<${segment.name}>[^/]+)`,
  );
  return `^/${segments.join("/")}$`;
}

export function createVercelRequestPath(path: string): string {
  const segments = parseRoutePath(path).map((segment) =>
    segment.name === undefined ? segment.value : `$${segment.name}`,
  );
  return `/${segments.join("/")}`;
}

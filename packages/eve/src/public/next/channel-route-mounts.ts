import type { CompiledChannelEntry } from "#compiler/manifest.js";

export interface EveChannelRouteMount {
  readonly publicPath: string;
  readonly routePath: string;
}

function joinRoutePrefix(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function isEveProtocolRoute(path: string): boolean {
  return path === "/eve/v1" || path.startsWith("/eve/v1/");
}

export function createEveChannelRouteMounts(input: {
  readonly channels: readonly CompiledChannelEntry[];
  readonly publicRoutePrefix: string;
}): readonly EveChannelRouteMount[] {
  const routePaths = new Set(
    input.channels
      .filter((channel) => channel.kind === "channel")
      .map((channel) => channel.urlPath)
      .filter((path) => !isEveProtocolRoute(path)),
  );

  return [...routePaths].sort().map((routePath) => ({
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
  if (!path.startsWith("/")) {
    throw new Error(`eve channel route ${JSON.stringify(path)} must start with "/".`);
  }

  return path
    .split("/")
    .slice(1)
    .map((segment) => {
      if (!segment.startsWith(":")) return { value: segment };
      const name = segment.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
          `eve channel route ${JSON.stringify(path)} has unsupported parameter ${JSON.stringify(segment)}.`,
        );
      }
      return { name, value: segment };
    });
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

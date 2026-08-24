import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";
import { isChannelRouteMethod, isHttpChannelRouteMethod } from "#channel/routes.js";

/**
 * Normalizes one authored channel definition into the canonical internal
 * shape consumed by the compiler.
 *
 * Authored channels must go through {@link defineChannel} (or a wrapper
 * like `slackChannel` / `eveChannel`) and therefore must be
 * {@link CompiledChannel} values. The legacy plain-`{ fetch, receive? }`
 * Route shape is no longer supported — drop a clear error for it so
 * users on old patterns get a useful migration hint instead of a silent
 * runtime crash deeper in dispatch.
 *
 * Disable sentinels are handled by the compiler before this function is
 * called.
 */
export function normalizeChannelDefinition(value: unknown, message: string): CompiledChannel {
  if (!isCompiledChannel(value)) {
    throw new Error(
      `${message} Use \`defineChannel({ routes, ... })\` (or a wrapper like \`slackChannel\` / \`eveChannel\`) — bare \`{ fetch, receive? }\` channel objects are no longer supported.`,
    );
  }
  assertValidAuthoredRoutes(value.routes, message);
  return value;
}

function assertValidAuthoredRoutes(routes: unknown, message: string): void {
  if (!Array.isArray(routes)) {
    throw new Error(`${message} Expected \`routes\` to be an array.`);
  }

  for (const [index, route] of routes.entries()) {
    assertValidAuthoredRoute(route, index, message);
  }
}

function assertValidAuthoredRoute(route: unknown, index: number, message: string): void {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    throwInvalidRoute(message, index, "must be an object");
  }

  const candidate = route as Record<string, unknown>;
  if (typeof candidate.path !== "string") {
    throwInvalidRoute(message, index, "must declare a string `path`");
  }
  if (typeof candidate.handler !== "function") {
    throwInvalidRoute(message, index, "must declare a function `handler`");
  }

  const method =
    typeof candidate.method === "string" ? candidate.method.toUpperCase() : candidate.method;
  if (candidate.transport === "websocket") {
    if (method !== "WEBSOCKET") {
      throwInvalidRoute(
        message,
        index,
        'uses `transport: "websocket"` and must declare method `"WEBSOCKET"`',
      );
    }
    return;
  }

  if (candidate.transport !== undefined && candidate.transport !== "http") {
    throwInvalidRoute(message, index, 'must use transport `"http"` or `"websocket"`');
  }
  if (!isHttpChannelRouteMethod(method)) {
    const detail = isChannelRouteMethod(method)
      ? 'HTTP transport cannot declare method `"WEBSOCKET"`'
      : "must declare a supported HTTP method";
    throwInvalidRoute(message, index, detail);
  }
}

function throwInvalidRoute(message: string, index: number, detail: string): never {
  throw new Error(`${message} Route at index ${index} ${detail}.`);
}

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const EVE_NUXT_PRODUCTION_ORIGIN_ENV = "EVE_NUXT_PRODUCTION_ORIGIN";
const EVE_NUXT_PRODUCTION_PORT_ENV = "EVE_NUXT_PRODUCTION_PORT";
const DEFAULT_EVE_NUXT_PRODUCTION_PORT = 4274;

export function resolveProductionTarget(input: {
  readonly portOffset: number;
  readonly publicPrefix: string;
}): string {
  const configuredOrigin = process.env[EVE_NUXT_PRODUCTION_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return `${new URL(configuredOrigin.trim()).origin}${input.publicPrefix}`;
  }

  const configuredPort = process.env[EVE_NUXT_PRODUCTION_PORT_ENV];
  let basePort = DEFAULT_EVE_NUXT_PRODUCTION_PORT;
  if (configuredPort !== undefined && configuredPort.trim().length > 0) {
    const port = Number.parseInt(configuredPort, 10);
    if (String(port) !== configuredPort.trim() || port < 1 || port > 65_535) {
      throw new Error(`${EVE_NUXT_PRODUCTION_PORT_ENV} must be an integer between 1 and 65535.`);
    }
    basePort = port;
  }

  const port = basePort + input.portOffset;
  if (port > 65_535) {
    throw new Error(`${EVE_NUXT_PRODUCTION_PORT_ENV} plus the eve agent count exceeds 65535.`);
  }
  return `http://127.0.0.1:${String(port)}${EVE_ROUTE_PREFIX}`;
}

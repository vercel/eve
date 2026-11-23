import { definePlatform } from "#platform/declaration.js";

export const defaultPlatform = definePlatform({
  deployment: () => ({
    environment: () => undefined,
    deploymentId: () => undefined,
    productionHost: () => undefined,
    publicHost: () => undefined,
    scope: () => undefined,
  }),
});

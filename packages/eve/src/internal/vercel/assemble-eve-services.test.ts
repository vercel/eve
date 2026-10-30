import { describe, expect, it } from "vitest";

import { assembleEveVercelServices } from "./assemble-eve-services.js";

describe("assembleEveVercelServices", () => {
  it.each([
    { name: undefined, serviceName: "eve", publicRoutePrefix: "" },
    { name: "support", serviceName: "eve-support", publicRoutePrefix: "/eve/support" },
  ])(
    "rejects an unrelated service occupying $serviceName",
    ({ name, serviceName, publicRoutePrefix }) => {
      const services = {
        [serviceName]: { framework: "hono", root: "api", buildCommand: "pnpm build:api" },
      };
      const routes = [
        { src: "^/api/(.*)$", destination: { service: serviceName, type: "service" } },
      ];

      expect(() =>
        assembleEveVercelServices({
          agents: [
            {
              agent: { appRoot: "/app/agent", buildCommand: "eve build", name, publicRoutePrefix },
              target: { hostOutputDirectory: "/app/.vercel/output", projectRoot: "/app" },
            },
          ],
          services,
          routes,
        }),
      ).toThrow(
        `Cannot generate eve service "${serviceName}": services["${serviceName}"] already defines a non-eve service. Rename the existing service and update its route destinations before adding this eve agent.`,
      );
      expect(services[serviceName]).toEqual({
        framework: "hono",
        root: "api",
        buildCommand: "pnpm build:api",
      });
      expect(routes).toEqual([
        { src: "^/api/(.*)$", destination: { service: serviceName, type: "service" } },
      ]);
    },
  );
});

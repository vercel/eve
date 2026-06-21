import { defineDynamic, defineTool } from "eve/tools";

export const OVERRIDE_TOKEN = "dynamic-override-ok-K2P7";

// The bare map key `override-target` collides with the authored tool of the
// same name. A dynamic tool wins on conflict, so calls to `override-target`
// must execute this version.
export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        "override-target": defineTool({
          description:
            "Smoke-test fixture: dynamic override of `override-target`. Only call when the user asks to use `override-target`.",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { source: "dynamic", token: OVERRIDE_TOKEN };
          },
        }),
      };
    },
  },
});

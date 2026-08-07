import { basename } from "node:path";

import { setupPhoton } from "./setup-flow.js";

import type { SetupIntegration } from "../types.js";

/** Photon project provisioning and iMessage channel scaffolding. */
export const PHOTON_SETUP: SetupIntegration = {
  kind: "photon",
  label: "Photon",
  hint: "Messages through Photon",
  async setup(context) {
    const result = await setupPhoton({
      agentName: basename(context.appRoot),
      projectPath: context.appRoot,
      environment: context.environment,
      ui: context.ui,
      signal: context.signal,
      force: context.force,
    });
    if (result.kind === "cancelled") return result;
    return {
      kind: "done",
      completion: {
        deployment: { required: true },
        facts: [
          ...(result.assignedPhoneNumber === undefined
            ? []
            : [
                {
                  label: "Text your agent",
                  value: result.assignedPhoneNumber,
                  kind: "phone" as const,
                },
              ]),
          { label: "Photon project", value: result.dashboardUrl, kind: "url" as const },
        ],
      },
    };
  },
};

import { basename } from "node:path";

import { setupPhoton } from "#setup/integrations/photon/setup-flow.js";

import type { ChannelSetupIntegration } from "../types.js";

/** Photon project provisioning and iMessage channel scaffolding. */
export const PHOTON_SETUP: ChannelSetupIntegration = {
  kind: "photon",
  label: "Photon",
  hint: "Messages through Photon",
  async setup(context) {
    if (context.state.projectPath.kind !== "resolved") {
      throw new Error("Project path has not been resolved.");
    }
    const result = await setupPhoton({
      agentName: basename(context.state.projectPath.path),
      projectPath: context.state.projectPath.path,
      environment: context.environment,
      ui: context.ui,
      signal: context.signal,
      force: context.force,
    });
    if (result.kind === "cancelled") return result;
    return {
      kind: "done",
      state: context.state,
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
    };
  },
};

import type { AuthoringSetup } from "../authoring-case.js";

/**
 * A developer's pulled environment. `eve build` evaluates extension mounts, so a
 * mount that passes a required secret needs it set wherever the project builds.
 */
export const crmLocalEnvSetup: AuthoringSetup = {
  id: "crm-local-env-v1",
  async onSession({ write }) {
    await write(".env.local", "CRM_API_KEY=local-crm-key\n");
  },
};

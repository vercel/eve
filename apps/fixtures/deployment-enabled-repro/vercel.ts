import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: {
      "**": false,
      master: true,
    },
  },
};

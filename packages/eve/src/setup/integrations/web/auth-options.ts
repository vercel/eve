import { select } from "#setup/ask.js";
import type { VercelTeamRequirement } from "#setup/vercel-project-api.js";

export const WEB_CHAT_TEAM_REQUIREMENT: VercelTeamRequirement = {
  permissions: {
    oauth2Application: ["create", "update"],
    projectEnvVars: ["create"],
    projectEnvVarsProduction: ["create"],
  },
  disabledReason: "Web Chat sign-in requires app and environment permissions; ask a team owner.",
};

export type WebAuthenticationChoice = "vercel" | "custom";

export const WEB_AUTHENTICATION_QUESTION = select<WebAuthenticationChoice>({
  key: "web-authentication",
  message: "How should people sign in to Web Chat?",
  options: [
    {
      id: "vercel",
      label: "Sign in with Vercel",
      hint: "Create a Vercel App for members of the linked project's team.",
      value: "vercel",
    },
    {
      id: "custom",
      label: "Configure authentication myself",
      hint: "Keep the current channel auth; the default rejects production browser requests.",
      value: "custom",
    },
  ],
  recommended: "vercel",
  required: true,
});

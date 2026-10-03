import { select } from "#setup/ask.js";

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

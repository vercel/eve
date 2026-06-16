export const authProviders = {
  slack: {
    id: "slack",
    name: "Slack",
  },
  vercel: {
    id: "vercel",
    name: "Vercel",
  },
} as const;

export const authProvidersList = [authProviders.slack, authProviders.vercel] as const;

export type AuthProviderId = (typeof authProvidersList)[number]["id"];

import { createAuthClient } from "better-auth/vue";

// Node fetch (SSR) requires an absolute base URL; the browser can use same-origin.
const baseURL = import.meta.server
  ? process.env.BETTER_AUTH_URL || "http://localhost:3000"
  : undefined;

export const authClient = createAuthClient(baseURL ? { baseURL } : undefined);

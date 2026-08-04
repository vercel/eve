"use client";

import { createAuthClient } from "better-auth/react";
import { staticCredentialsClient } from "@/lib/better-auth/static-credentials";

export const authClient = createAuthClient({
  plugins: [staticCredentialsClient()],
});

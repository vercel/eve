import type { ToolAuthProvider } from "eve/tools";

/** A per-user credential: each person's token names them, so a result shows whose was used. */
export const releaseAuth: ToolAuthProvider = {
  principalType: "user",
  async getToken({ principal }) {
    return { token: `release-token:${principal.type === "user" ? principal.id : "app"}` };
  },
};

import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { accessScopeForUser, localDeveloperUserId } from "@/lib/auth/scope";

// Users reach evey over iMessage. This HTTP channel exists for the local
// `eve dev` terminal UI, evals, and your team's Vercel tooling; it never
// admits end users in production.
const authenticateLocalDev = localDev();

export default eveChannel({
  auth: [
    vercelOidc(),
    async (request) => {
      const local = await authenticateLocalDev(request);
      if (!local) return null;
      // The local developer acts as one fixed shopper so tools that need an
      // shopper identity work without signing in.
      const scope = accessScopeForUser(localDeveloperUserId);
      return {
        ...local,
        // Keep local operator introspection after mapping the caller to a user.
        allowAgentInfo: true,
        // Evals replace tools such as Agentcard with fixed responses so they
        // never reach external services. `localDev()` admits only local
        // callers, and eve drops the grant before it saves the identity.
        allowToolStubs: true,
        attributes: {
          ...local.attributes,
          conversationChannel: "local",
          workspaceId: scope.workspaceId,
        },
        issuer: "evey-local",
        principalId: scope.userId,
        principalType: "user" as const,
      };
    },
    placeholderAuth(),
  ],
});

import { localDev, vercelOidc, withAuthChallenges } from "eve/channels/auth";
import { eveChannel, type EveAuthFn } from "eve/channels/eve";

export default eveChannel({
  // This isolated fixture has no production tools or data.
  auth: [vercelOidc(), localDev()].map((authenticate): EveAuthFn =>
    withAuthChallenges(
      async (request) => {
        const auth = await authenticate(request);
        return auth ? { ...auth, allowToolStubs: true } : null;
      },
      [{ scheme: "Bearer" }],
    ),
  ),
});

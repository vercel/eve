import { localDev, vercelOidc, withAuthChallenges } from "eve/channels/auth";
import { eveChannel, type EveAuthFn } from "eve/channels/eve";

export default eveChannel({
  // This isolated fixture stores no conversations, so its eval runner may start sessions from any history.
  auth: [vercelOidc(), localDev()].map((authenticate): EveAuthFn =>
    withAuthChallenges(
      async (request) => {
        const auth = await authenticate(request);
        return auth ? { ...auth, allowHistoryImport: true } : null;
      },
      [{ scheme: "Bearer" }],
    ),
  ),
});

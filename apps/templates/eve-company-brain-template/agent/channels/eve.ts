import { eveChannel } from "eve/channels/eve";
import { withAuthChallenges } from "eve/channels/auth";
import { authenticateDevelopmentHttp } from "../lib/access.ts";

export default eveChannel({
  auth: withAuthChallenges(
    (request: Request) => authenticateDevelopmentHttp(request, process.env),
    [{ scheme: "Basic", parameters: { realm: "company-brain", charset: "UTF-8" } }],
  ),
});

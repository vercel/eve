import { verifyHttpBasic, withAuthChallenges } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const benchAuth = withAuthChallenges(
  (request: Request) => {
    const password = process.env.EVE_BENCH_TOKEN;
    if (!password) return null;
    const result = verifyHttpBasic(request.headers.get("authorization"), {
      username: "code-bench",
      password,
    });
    return result.ok ? result.sessionAuth : null;
  },
  [{ scheme: "Basic", parameters: { realm: "code-bench", charset: "UTF-8" } }],
);

export default eveChannel({ auth: [benchAuth] });

import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { type EveAuthFn, eveChannel } from "eve/channels/eve";

const localDevAuth = localDev();

// The evals in `evals/` replace Slack tools with fixed results, which needs
// `allowToolStubs`. `localDev()` admits callers only on a local `eve dev`
// server, so production keeps eve's default policy: Vercel OIDC, then a 401.
const localDevWithStubs: EveAuthFn = async (request) => {
  const caller = await localDevAuth(request);
  return caller ? { ...caller, allowAgentInfo: true, allowToolStubs: true } : null;
};

export default eveChannel({ auth: [localDevWithStubs, vercelOidc(), placeholderAuth()] });

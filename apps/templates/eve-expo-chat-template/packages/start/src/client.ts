import { EveClient } from "./relay-client.ts";
import { config, appOrigin, SETUP_HELP } from "./config.ts";
export function client() {
  const settings = config();
  if (!settings.agentToken) throw Error("EVE_START_AGENT_TOKEN is missing. " + SETUP_HELP);
  return new EveClient(appOrigin(), settings.agentToken, {
    bypassToken: settings.appBypassToken,
  });
}

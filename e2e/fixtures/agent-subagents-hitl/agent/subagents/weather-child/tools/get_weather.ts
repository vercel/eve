import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  EXCHANGE_FAILURE,
  FAILING_CODE,
  GRANT_TOKEN,
  HOLD_MS,
  WEATHER_GRANT,
  type WeatherResult,
} from "../../../lib/weather-sign-in";

/** The weather sign-in; `grant` is the one the call carries, if any. */
function weatherAuth(grant: string | undefined) {
  return defineInteractiveAuthorization<{ marker: string }>({
    vercelConnect: { connector: WEATHER_GRANT },
    async getToken() {
      if (grant === CODE_TOKEN || grant === GRANT_TOKEN) return { token: GRANT_TOKEN };
      throw new ConnectionAuthorizationRequiredError("weather");
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: { displayName: "Fixture Weather", url: callbackUrl },
        resume: { marker: "fixture-weather" },
      };
    },
    async completeAuthorization({ callback, resume }) {
      if (resume?.marker !== "fixture-weather") throw new Error("Fixture weather state mismatch.");
      const { code, error } = callback.params;
      if (code === ACCEPT_CODE) return { token: CODE_TOKEN };
      if (code === FAILING_CODE) throw new Error(EXCHANGE_FAILURE);
      // The shown card was accepted: the provider holds the grant this sign-in waited on.
      if (code === undefined && error === undefined) return { token: GRANT_TOKEN };
      throw new ConnectionAuthorizationFailedError("weather", {
        message: `The weather sign-in didn't finish (${error ?? "unknown code"}).`,
      });
    },
  });
}

export default defineTool({
  description: "Get the weather for a city. Needs the person's weather sign-in.",
  inputSchema: z.object({
    city: z.string(),
    /** Hold for a while when this call's own sign-in minted its token. */
    hold: z.boolean().optional(),
    /** A grant to run on, with no sign-in. */
    grant: z.string().optional(),
    /** The sign-in's scope; another scope of the same grant asks again. */
    scope: z.string().optional(),
  }),
  async execute(input, ctx): Promise<WeatherResult> {
    const token = await ctx.getToken(weatherAuth(input.grant), {
      authKey: input.scope ?? "weather",
      displayName: "Fixture Weather",
    });
    if (input.hold === true && token.token === CODE_TOKEN) await sleep(HOLD_MS);
    return { city: input.city, finishedAt: Date.now(), token: token.token };
  },
});

import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  type ConnectionPrincipal,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { awaitReturned, markReturned, readGrant, storeGrant } from "./weather-grants";
import {
  ACCEPT_CODE,
  CODE_TOKEN,
  EXCHANGE_FAILURE,
  FAILING_CODE,
  GRANT_TOKEN,
  HOLD_LIMIT_MS,
  OTHER_GRANT,
  WEATHER_GRANT,
  type WeatherResult,
} from "./weather-sign-in";

/** Which of the two fixture grants a call needs: `weather`, or `other`, another connector. */
export type WeatherGrant = "weather" | "other";

/** Where the provider keeps `principal`'s `grant`: one per person and grant. */
function grantKey(principal: ConnectionPrincipal, grant: WeatherGrant): string {
  if (principal.type !== "user") throw new Error("The weather sign-in needs a person.");
  return grant === "weather" ? principal.id : `${principal.id}/${grant}`;
}

/** A weather sign-in, a Vercel Connect grant whose provider is faked at its edge. */
const weatherAuth = (grant: WeatherGrant) =>
  defineInteractiveAuthorization<{ marker: string }>({
    vercelConnect: { connector: grant === "weather" ? WEATHER_GRANT : OTHER_GRANT },
    async getToken({ principal }) {
      const token = await readGrant(grantKey(principal, grant));
      if (token === undefined) throw new ConnectionAuthorizationRequiredError("weather");
      return { token };
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: { displayName: "Fixture Weather", url: callbackUrl },
        resume: { marker: "fixture-weather" },
      };
    },
    async completeAuthorization({ callback, principal, resume }) {
      if (resume?.marker !== "fixture-weather") throw new Error("Fixture weather state mismatch.");
      const person = grantKey(principal, grant);
      const { code, error } = callback.params;
      if (code === ACCEPT_CODE) {
        await storeGrant(person, GRANT_TOKEN);
        return { token: CODE_TOKEN };
      }
      if (code === FAILING_CODE) throw new Error(EXCHANGE_FAILURE);
      // The shown card was accepted, so the provider now holds the grant this sign-in waited on.
      if (code === undefined && error === undefined) {
        const token = await readGrant(person);
        if (token === undefined) throw new Error("The accepted weather sign-in left no grant.");
        return { token };
      }
      throw new ConnectionAuthorizationFailedError("weather", {
        message: `The weather sign-in didn't finish (${error ?? "unknown code"}).`,
      });
    },
  });

const auths = { other: weatherAuth("other"), weather: weatherAuth("weather") };

/** The weather tool the parent and the weather children both call. */
export const weatherTool = defineTool({
  description: "Get the weather for a city. Needs the person's weather sign-in.",
  inputSchema: z.object({
    city: z.string(),
    /** When this call's own sign-in minted its token, hold until these cities' calls return. */
    holdFor: z.array(z.string()).optional(),
    /** The grant the call needs; `weather` when absent. */
    grant: z.enum(["weather", "other"]).optional(),
  }),
  async execute(input, ctx): Promise<WeatherResult> {
    const grant = input.grant ?? "weather";
    const token = await ctx.getToken(auths[grant], {
      authKey: grant,
      displayName: "Fixture Weather",
    });
    if (input.holdFor === undefined)
      return { city: input.city, finishedAt: Date.now(), token: token.token };
    const person = ctx.session.auth.current?.principalId;
    if (person === undefined) throw new Error("A held weather call needs a person.");
    if (token.token === CODE_TOKEN) {
      await awaitReturned(person, input.holdFor, HOLD_LIMIT_MS);
      return { city: input.city, finishedAt: Date.now(), token: token.token };
    }
    // Stamped before it is recorded, so the held call that reads the record finishes after it.
    const finishedAt = Date.now();
    await markReturned(person, input.city);
    return { city: input.city, finishedAt, token: token.token };
  },
});

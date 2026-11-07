import { defineAgent, type DefinedAgent } from "eve";
import { mockModel } from "eve/evals";

import {
  CHILD_MARKER,
  CHILD_REPORT,
  planAfter,
  type ChildPlan,
  type WeatherResult,
} from "../../lib/weather-sign-in";

/**
 * Checks the weather for the city the parent names, which needs the person's weather sign-in,
 * then reports every call's result. With `again`, it then revokes the grant at the provider and
 * checks Porto, which has to sign in again.
 */
const agent: DefinedAgent = defineAgent({
  description: "Check the weather for a city, which needs the person's weather sign-in.",
  model: mockModel(({ lastUserMessage, toolResults }) => {
    const plan = planAfter<ChildPlan>(lastUserMessage, CHILD_MARKER);
    if (plan === undefined) return `Mock reply: ${lastUserMessage ?? ""}`;
    const calls = toolResults.filter((result) => result.name === "get_weather");
    if (calls.length === 0)
      return {
        toolCalls: [
          {
            input: { city: plan.city, holdFor: plan.holdFor },
            name: "get_weather",
          },
        ],
      };
    const revoked = toolResults.some((result) => result.name === "revoke_weather_grant");
    if (plan.again === true && calls.length === 1 && !calls[0]!.isError)
      return revoked
        ? {
            toolCalls: [
              { input: { city: plan.city.replace("Lisbon", "Porto") }, name: "get_weather" },
            ],
          }
        : { toolCalls: [{ input: {}, name: "revoke_weather_grant" }] };
    return calls.map((call) => `${CHILD_REPORT} ${describe(call.output, call.isError)}`).join("\n");
  }),
  modelContextWindowTokens: 1_000_000,
});

export default agent;

/** One call's result as one line: `[city] token=<token> at=<ms>`, or the error it ended with. */
function describe(output: unknown, isError: boolean): string {
  const result = output as Partial<WeatherResult> | undefined;
  if (isError || result?.token === undefined) return `error=${JSON.stringify(output)}`;
  return `[${result.city}] token=${result.token} at=${result.finishedAt}`;
}

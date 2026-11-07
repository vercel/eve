import { defineAgent, type DefinedAgent } from "eve";
import { mockModel } from "eve/evals";

import {
  CHILD_MARKER,
  CHILD_REPORT,
  describeCall,
  planAfter,
  type ChildPlan,
} from "../../lib/weather-sign-in";

/**
 * Checks the weather for the city the parent names, which needs the person's weather sign-in,
 * then reports every call's result. With `again`, it then revokes the grant at the provider and
 * checks Porto, which has to sign in again. With `retry`, a first call that fails is made once more.
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
            input: {
              city: plan.city,
              holdFor: plan.holdFor,
              ...(plan.other === true && { grant: "other" }),
              ...(plan.afterParent === true && { afterParent: true }),
            },
            name: "get_weather",
          },
        ],
      };
    if (plan.retry === true && calls.length === 1 && calls[0]!.isError)
      return { toolCalls: [{ input: { city: plan.city }, name: "get_weather" }] };
    const revoked = toolResults.some((result) => result.name === "revoke_weather_grant");
    if (plan.again === true && calls.length === 1 && !calls[0]!.isError)
      return revoked
        ? {
            toolCalls: [
              { input: { city: plan.city.replace("Lisbon", "Porto") }, name: "get_weather" },
            ],
          }
        : { toolCalls: [{ input: {}, name: "revoke_weather_grant" }] };
    return calls
      .map((call) => `${CHILD_REPORT} ${describeCall(call.output, call.isError)}`)
      .join("\n");
  }),
  modelContextWindowTokens: 1_000_000,
});

export default agent;

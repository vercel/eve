/**
 * The weather sign-in the fan-in evals drive: a Vercel Connect grant, faked at its edge.
 *
 * The person answers the shown card by calling its callback with `code`. A child that waited on
 * that card hears the answer as a callback with no `code` and no `error`, and reads the grant the
 * provider then holds. The fixture keeps no grant between calls: a call carries the grant it runs
 * on in its input, so evals that run at once on one deployment, across instances, never share one.
 */

/** The Connect connector every weather sign-in names, so parallel children share one card. */
export const WEATHER_GRANT = "oauth/fixture-weather";

/** The `code` a person's accepted sign-in carries. */
export const ACCEPT_CODE = "fixture-ok";

/** A `code` whose token exchange fails, as a provider outage would. */
export const FAILING_CODE = "fixture-exchange-fails";

/** Why the token exchange for {@link FAILING_CODE} fails. */
export const EXCHANGE_FAILURE = "The fixture token endpoint answered 500.";

/** The token the answered sign-in's own exchange mints. */
export const CODE_TOKEN = "fixture-weather-token-from-code";

/** The token a sign-in that waited on the answered card reads from the stored grant. */
export const GRANT_TOKEN = "fixture-weather-token-from-grant";

/** How long a held call runs after its answered sign-in completes. */
export const HOLD_MS = 5_000;

/** What the parent's mock model reads from an eval's prompt. */
export interface FanInPlan {
  /** How many weather children the parent runs. */
  readonly children: number;
  /** Each child's call holds for {@link HOLD_MS} when its own exchange minted its token. */
  readonly hold?: boolean;
  /** Child 0 checks Porto under another scope once Lisbon returns. */
  readonly again?: boolean;
  /** The last child starts only after the others report, with the grant they ran on. */
  readonly late?: boolean;
}

/** What the parent tells one weather child. */
export interface ChildPlan {
  readonly city: string;
  readonly hold?: boolean;
  readonly again?: boolean;
  /** A grant the child's call runs on, with no sign-in. */
  readonly grant?: string;
}

/** What one weather call returns. */
export interface WeatherResult {
  readonly city: string;
  readonly token: string;
  readonly finishedAt: number;
}

export const FAN_IN_MARKER = "SIGN-IN-FAN-IN";
export const FAN_IN_DONE = "SIGN-IN-FAN-IN-DONE";
export const CHILD_MARKER = "WEATHER-CHILD";
export const CHILD_REPORT = "WEATHER-REPORT";

/** The JSON after `marker` in `text`, when it is there. */
export function planAfter<T>(text: string | null, marker: string): T | undefined {
  if (text === null) return undefined;
  const start = text.indexOf(`${marker} {`);
  if (start < 0) return undefined;
  const json = text.slice(start + marker.length + 1);
  const end = json.indexOf("}");
  return end < 0 ? undefined : (JSON.parse(json.slice(0, end + 1)) as T);
}

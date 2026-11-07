/**
 * The weather sign-in the fan-in evals drive: a Vercel Connect grant, faked at its edge.
 *
 * The person answers the shown card at the provider's consent link
 * (`channels/weather-provider.ts`) with `code`. As Vercel Connect does, the provider stores the
 * grant on acceptance before it calls eve back. A child that waited on that card hears the answer
 * as a callback with no `code` and no `error`, and reads the grant the provider already holds. The provider keeps one grant per person (`weather-grants.ts`), and each eval
 * asks as a new person, so evals that run at once on one deployment never share a grant.
 */

/** The Connect connector every weather sign-in names, so parallel children share one card. */
export const WEATHER_GRANT = "oauth/fixture-weather";

/** Another connector, whose sign-ins never share a card with {@link WEATHER_GRANT}'s. */
export const OTHER_GRANT = "oauth/fixture-weather-other";

/** The `code` a person's accepted sign-in carries. */
export const ACCEPT_CODE = "fixture-ok";

/** A `code` whose token exchange fails, as a provider outage would. */
export const FAILING_CODE = "fixture-exchange-fails";

/** Why the token exchange for {@link FAILING_CODE} fails. */
export const EXCHANGE_FAILURE = "The fixture token endpoint answered 500.";

/** The token the answered sign-in's own token exchange returns. */
export const CODE_TOKEN = "fixture-weather-token-from-code";

/** The token the stored grant yields to every later read. */
export const GRANT_TOKEN = "fixture-weather-token-from-grant";

/** How long a held call waits for the others before it fails. */
export const HOLD_LIMIT_MS = 30_000;

/** What the parent's mock model reads from an eval's prompt. */
export interface FanInPlan {
  /** How many weather children the parent runs. */
  readonly children: number;
  /** The child whose own exchange minted its token holds its call until the others return. */
  readonly hold?: boolean;
  /** Child 0 revokes the grant once Lisbon returns, then checks Porto. */
  readonly again?: boolean;
  /** The last child starts only after the others report. */
  readonly late?: boolean;
  /** The parent checks Lisbon itself once the children started, while their calls are out. */
  readonly parent?: boolean;
  /** The children ask for their sign-ins only once the parent asked for its own. */
  readonly parentFirst?: boolean;
  /** Child 0 calls again after its first call fails. */
  readonly retry?: boolean;
  /** The children from this index on need the other grant. */
  readonly otherFrom?: number;
  /** Every child's sign-in names no Connect grant, so none can share another's card. */
  readonly noGrant?: boolean;
}

/** What the parent tells one weather child. */
export interface ChildPlan {
  readonly city: string;
  /** The other children's cities: this call holds until theirs return, if it answered the card. */
  readonly holdFor?: readonly string[];
  readonly again?: boolean;
  /** Call again once after the first call fails. */
  readonly retry?: boolean;
  /** The grant the call needs, when it isn't the weather grant. */
  readonly grant?: "other" | "none";
  /** Asks for its sign-in only once the parent asked for its own. */
  readonly afterParent?: boolean;
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

/** One call's result as one line: `[city] token=<token> at=<ms>`, or the error it ended with. */
export function describeCall(output: unknown, isError: boolean): string {
  const result = output as Partial<WeatherResult> | undefined;
  if (isError || result?.token === undefined) return `error=${JSON.stringify(output)}`;
  return `[${result.city}] token=${result.token} at=${result.finishedAt}`;
}

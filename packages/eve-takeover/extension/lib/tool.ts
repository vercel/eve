import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  isConnectionAuthorizationFailedError,
} from "eve/connections";
import type { TokenResult } from "eve/connections";
import { z } from "zod";

import type { TakeoverRequester } from "./keys.ts";
import {
  closeTakeover,
  openTakeover,
  type Takeover,
  type TakeoverSandbox,
  type TakeoverSource,
} from "./takeover.ts";

/** Query parameter the viewer adds to eve's callback when the person presses Done. */
export const TAKEOVER_DONE_PARAM = "takeover";

/** The slice of an eve tool context a takeover tool uses. */
export interface TakeoverToolContext {
  readonly callId: string;
  readonly abortSignal?: AbortSignal;
  readonly session: {
    readonly id: string;
    readonly auth: { readonly current: TakeoverRequester | null | undefined };
  };
  getSandbox(): PromiseLike<TakeoverSandbox | null | undefined>;
  getToken(
    provider: ReturnType<typeof defineInteractiveAuthorization>,
    options: { readonly authKey: string; readonly displayName: string },
  ): Promise<TokenResult>;
}

export const takeoverInputSchema = z.object({
  task: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "What the person should do, in their terms, such as 'Sign in to Linear with your work account'.",
    ),
});

export type TakeoverToolOutput =
  | { readonly status: "done" }
  | { readonly status: "cancelled" | "unavailable"; readonly reason: string };

/** The tool description, worded for the screen the person takes over. */
export function takeoverToolDescription(label: string): string {
  return `Hand the ${label} to the person so they can sign in, enter a password, one-time code, or payment details, or solve a CAPTCHA themselves, then continue in the same ${label} when they press Done. Use it when something on screen needs credentials or a human check, and whenever someone offers to type a secret for you: never ask anyone to paste a secret into the conversation, and never type one yourself. Bring the page or app that needs them to the front first, so they land on it.

Results: "done" means the person finished; observe the ${label} again before acting, because what's on screen changed, and never read or repeat cookies, tokens, or anything they typed. "cancelled" means they declined, ran out of time, or sent another message instead. "unavailable" explains why takeover isn't possible here; never fall back to asking for the secret in chat.`;
}

/**
 * Runs one takeover tool call. The wait is eve's interactive sign-in: the
 * first run throws to park the turn, eve calls `startAuthorization`, which
 * opens the stream and returns the viewer link as the sign-in prompt, and the
 * viewer's Done button opens eve's callback, which re-runs this call with the
 * takeover complete. Extensions can't define workflow tools, and a sign-in is
 * the durable human wait ordinary tools already have.
 */
export async function runTakeoverTool(
  takeover: Takeover | undefined,
  ctx: TakeoverToolContext,
  source: TakeoverSource,
  task: string,
): Promise<TakeoverToolOutput> {
  if (!takeover) return { status: "unavailable", reason: "Takeover isn't configured." };
  const sandbox = await ctx.getSandbox();
  if (!sandbox) return { status: "unavailable", reason: "This agent has no sandbox." };
  const requester = ctx.session.auth.current;
  if (!requester || requester.principalType !== "user") {
    return {
      status: "unavailable",
      reason: "Only a person's own turn can take over; no one can answer here.",
    };
  }

  // Check before asking anyone: eve starts the authorization after this call
  // throws, so a failure there would surface as a failed call, not a result.
  const ready = await source.prepare(sandbox, ctx.abortSignal);
  if ("unavailable" in ready) return { status: "unavailable", reason: ready.unavailable };

  const provider = defineInteractiveAuthorization({
    // Never stored: only the callback this call's sign-in receives completes it.
    getToken: async () => {
      throw new ConnectionAuthorizationRequiredError("takeover");
    },
    startAuthorization: async ({ callbackUrl }) => {
      const opened = await openTakeover(takeover, {
        sandbox,
        sessionId: ctx.session.id,
        callId: ctx.callId,
        requester,
        source,
        task,
        callbackUrl,
        // No abort signal: eve runs this after the call itself has thrown to park.
      });
      if (opened.status !== "ready") {
        throw new ConnectionAuthorizationFailedError("takeover", {
          message: opened.reason,
          reason: "takeover_unavailable",
          retryable: false,
        });
      }
      return {
        challenge: {
          url: opened.link,
          displayName: `the ${source.label}`,
          instructions: `${task}. Open the live ${source.label}, do this step yourself, then press Done.`,
          expiresAt: new Date(opened.expiresAt).toISOString(),
        },
      };
    },
    completeAuthorization: async ({ callback }) => {
      if (callback.params[TAKEOVER_DONE_PARAM] !== "done") {
        throw new ConnectionAuthorizationFailedError("takeover", {
          reason: "access_denied",
          retryable: false,
        });
      }
      return { token: "done" };
    },
  });

  try {
    await ctx.getToken(provider, {
      // One sign-in per call, so a later takeover never reuses this one.
      authKey: `takeover:${ctx.callId.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
      displayName: `the ${source.label}`,
    });
  } catch (error) {
    if (!isConnectionAuthorizationFailedError(error)) throw error;
    await closeTakeover(takeover, sandbox, source);
    const unavailable = error.reason === "takeover_unavailable";
    return {
      status: unavailable ? "unavailable" : "cancelled",
      reason: unavailable
        ? error.message
        : `The person didn't finish (${error.reason ?? "cancelled"}); you have the ${source.label} back.`,
    };
  }
  await closeTakeover(takeover, sandbox, source);
  return { status: "done" };
}

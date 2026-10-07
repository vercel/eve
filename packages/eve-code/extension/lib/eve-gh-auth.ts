import { defineState, type StateHandle } from "eve/context";
import {
  defineTool,
  type ToolAuthProvider,
  type ToolContext,
  type ToolDefinition,
} from "eve/tools";
import { z } from "zod";

import extension from "../extension.ts";
import type { EveGhSandboxOptions } from "./eve-gh-sandbox.ts";

export interface EveGhSettings {
  readonly repository: string;
  readonly revision?: string;
  readonly teamId: string;
  readonly projectId: string;
}

interface Owner {
  readonly caller: string;
  readonly vercelUserId: string;
}

const owner = defineState<Owner | null>("eve-code.eve-gh-owner", () => null);
/**
 * Creation credentials for the in-flight `getSandbox()` call, keyed by session id.
 * Entries live in process memory only for the duration of one call, so the
 * user's token never reaches durable state, config, tool output, or VM files.
 * Opens are serialized per session (`sessionOpens`), so at most one entry per
 * session exists and an overlapping call can never overwrite the active one.
 */
const creationAuth = new Map<string, EveGhSandboxOptions>();
const sessionOpens = new Map<string, Promise<void>>();

async function openExclusively<T>(
  sessionId: string,
  options: EveGhSandboxOptions,
  open: () => Promise<T>,
): Promise<T> {
  const previous = sessionOpens.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  sessionOpens.set(sessionId, tail);
  await previous;
  creationAuth.set(sessionId, options);
  try {
    return await open();
  } finally {
    creationAuth.delete(sessionId);
    release();
    if (sessionOpens.get(sessionId) === tail) sessionOpens.delete(sessionId);
  }
}

const userSchema = z.object({
  sub: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  preferred_username: z.string().trim().min(1),
  email: z.email(),
});

export function currentEveGhAuth(sessionId: string): EveGhSandboxOptions {
  const options = creationAuth.get(sessionId);
  if (!options)
    throw new Error("Authorize Vercel through an eve-gh tool before opening the sandbox.");
  return options;
}

/**
 * Settings plus the user-scoped Vercel authorization. The provider comes from the
 * consumer (for example `connect()` from `@vercel/connect/eve`): eve compiles this
 * extension and cannot import that adapter itself.
 */
export interface EveGhAccess extends EveGhSettings {
  readonly auth: ToolAuthProvider;
}

export async function getEveGhSandbox(
  ctx: ToolContext,
  access: EveGhAccess,
  ownership: StateHandle<Owner | null> = owner,
  send: typeof fetch = globalThis.fetch,
) {
  const principal = ctx.session.auth.current;
  if (principal?.principalType !== "user") {
    throw new Error("eve-gh requires an authenticated user.");
  }
  const caller = JSON.stringify([principal.issuer ?? null, principal.principalId]);
  if (ownership.get() !== null && ownership.get()?.caller !== caller) {
    throw new Error("This eve-gh sandbox belongs to another user. Start a new coding session.");
  }
  const { auth: provider, ...settings } = access;
  const { token } = await ctx.getToken(provider);
  const response = await send("https://api.vercel.com/login/oauth/userinfo", {
    headers: { authorization: `Bearer ${token}` },
    signal: ctx.abortSignal,
  });
  if (response.status === 401) ctx.requireAuth(provider);
  if (!response.ok) throw new Error(`Vercel account lookup failed (${response.status}).`);
  const user = userSchema.parse(await response.json());
  ownership.update((previous) => {
    if (previous && (previous.caller !== caller || previous.vercelUserId !== user.sub)) {
      throw new Error(
        "This eve-gh sandbox belongs to another Vercel account. Start a new coding session.",
      );
    }
    return { caller, vercelUserId: user.sub };
  });

  // Only nonsecret ownership is authored state. The provider reads the current
  // user's token for this session only while this call is opening the sandbox.
  const options: EveGhSandboxOptions = {
    ...settings,
    enabled: true,
    token,
    commitAs: { name: user.name ?? user.preferred_username, email: user.email },
  };
  return openExclusively(ctx.session.id, options, () => ctx.getSandbox());
}

export function withEveGhAuth<I, O>(tool: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return defineTool({
    ...tool,
    execute(input, ctx) {
      return tool.execute(input, {
        ...ctx,
        async getSandbox() {
          const config = extension.config.eveGh;
          if (config?.enabled !== true) throw new Error("eve-gh sandbox is disabled.");
          return getEveGhSandbox(ctx, {
            ...(await config.resolveOptions()),
            auth: config.auth,
          });
        },
      });
    },
  });
}

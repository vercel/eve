import { del, get, put } from "#compiled/@vercel/blob/index.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";

const DEFAULT_PATHNAME = "eve/discord/gateway-session.json";

/** A Gateway session a stopping relay left for the next one to resume. */
export interface DiscordGatewaySession {
  readonly sessionId: string;
  readonly resumeUrl: string;
  /** Sequence number of the last dispatch the stopping relay received. */
  readonly sequence: number;
  /** When the stopping relay saved the session, in milliseconds since the epoch. */
  readonly savedAt: number;
}

/**
 * Where a stopping relay leaves its Gateway session, so the relay that replaces
 * it resumes the session and Discord replays the messages sent in between.
 */
export interface DiscordGatewayHandoff {
  /** Removes and returns the saved session, or `undefined` when there is none. */
  take(): Promise<DiscordGatewaySession | undefined>;
  /** Saves the session, replacing any saved one. */
  put(session: DiscordGatewaySession): Promise<void>;
}

/** Credentials and pathname for {@link vercelBlobHandoff}. */
export interface VercelBlobHandoffOptions {
  /** Vercel Blob read-write token. Defaults to `BLOB_READ_WRITE_TOKEN`. */
  readonly token?: string;
  /** Vercel OIDC token. Defaults to `VERCEL_OIDC_TOKEN`. */
  readonly oidcToken?: string;
  /** Blob store ID used with OIDC. Defaults to `BLOB_STORE_ID`. */
  readonly storeId?: string;
  /** Pathname of the session object. Defaults to `eve/discord/gateway-session.json`. */
  readonly pathname?: string;
}

/** Hands the Gateway session over through one private Vercel Blob object. */
export function vercelBlobHandoff(options: VercelBlobHandoffOptions = {}): DiscordGatewayHandoff {
  const pathname = options.pathname ?? DEFAULT_PATHNAME;
  const credentials = {
    oidcToken: options.oidcToken,
    storeId: options.storeId,
    token: options.token,
  };

  return {
    async take() {
      const result = await get(pathname, {
        ...credentials,
        access: "private",
        headers: { "accept-encoding": "identity" },
        useCache: false,
      });
      if (result === null || result.statusCode !== 200 || result.stream === null) return undefined;
      const body: unknown = JSON.parse(await new Response(result.stream).text());
      await del(pathname, credentials);
      return isDiscordGatewaySession(body) ? body : undefined;
    },
    async put(session) {
      await put(pathname, JSON.stringify(session), {
        ...credentials,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
    },
  };
}

function isDiscordGatewaySession(value: unknown): value is DiscordGatewaySession {
  return (
    isObject(value) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.resumeUrl) &&
    typeof value.sequence === "number" &&
    typeof value.savedAt === "number"
  );
}

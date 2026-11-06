import type {
  SlackBotToken,
  SlackChannelCredentials,
  SlackTransportOptions,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { defineExtension } from "eve/extension";
import type { ToolAuthProvider } from "eve/tools";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";

/** Where a Slack caller asked, and who they are. */
export interface SlackSearchAudience {
  /** The Slack conversation the caller asked in. Answers are posted there. */
  readonly channelId: string;
  /** The conversation is shared with another organization through Slack Connect. */
  readonly sharedChannel: boolean;
  /** The caller's home workspace isn't the one the app is installed in. */
  readonly external: boolean;
  /** The caller is a single-channel or multi-channel guest. */
  readonly guest: boolean;
}

/** What a Slack search tool is about to show the caller. */
export interface SlackSearchAccessRequest {
  readonly tool: "search" | "read_conversation" | "read_user";
  /** The turn's caller. */
  readonly auth: SessionAuthContext | null;
  /** The channel whose messages would be returned. Absent for `read_user`. */
  readonly channelId?: string;
  /** Set when the caller asked in Slack. Absent for other callers, such as web sessions. */
  readonly slack?: SlackSearchAudience;
}

/** Returns `false` to withhold a channel's messages or a user lookup from the caller. */
export type SlackSearchAuthorize = (
  request: SlackSearchAccessRequest,
) => boolean | Promise<boolean>;

/** Configuration for `eve/extensions/slack-search`. */
export interface SlackSearchExtensionConfig {
  /**
   * The Slack channel's credentials, the same object `slackChannel` takes. Only `botToken` is
   * used; a function provider receives the workspace that received the turn's message. Falls
   * back to `process.env.SLACK_BOT_TOKEN`.
   */
  readonly credentials?: Pick<SlackChannelCredentials, "botToken">;
  /**
   * Per-user Slack sign-in, such as `connect("slack/my-agent")` from `@vercel/connect/eve`.
   * When set, a person can search without a fresh Slack message, and read public channels the
   * bot isn't in, with their own user token. eve asks them to sign in the first time.
   */
  readonly userAuth?: ToolAuthProvider;
  /** Slack API transport overrides, as in `slackChannel({ api })`. */
  readonly api?: SlackTransportOptions;
  /**
   * Decides which channels and user lookups each caller may see. Called for every channel a
   * tool would return messages from. When omitted, guests see nothing, and callers in a Slack
   * Connect conversation or from another workspace see only the conversation they asked in;
   * everyone else sees every public channel.
   */
  readonly authorize?: SlackSearchAuthorize;
}

const isFunction = (value: unknown) => typeof value === "function";

const schema = z.object({
  credentials: z
    .object({
      botToken: z.union([z.string().trim().min(1), z.custom<SlackBotToken>(isFunction)]).optional(),
    })
    .optional(),
  userAuth: z
    .custom<ToolAuthProvider>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "principalType") === "user" &&
        typeof Reflect.get(value, "getToken") === "function",
      'userAuth must be a user sign-in, such as connect("slack/my-agent") from @vercel/connect/eve.',
    )
    .optional(),
  api: z
    .custom<SlackTransportOptions>((value) => typeof value === "object" && value !== null)
    .optional(),
  authorize: z.custom<SlackSearchAuthorize>(isFunction, "authorize must be a function").optional(),
});

// Typed as a Standard Schema so the public declaration names eve's own config type instead of Zod's.
const config: StandardSchemaV1<SlackSearchExtensionConfig> = schema;

export default defineExtension({ config });

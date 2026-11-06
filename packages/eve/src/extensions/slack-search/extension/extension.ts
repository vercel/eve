import type {
  SlackBotToken,
  SlackChannelCredentials,
  SlackTransportOptions,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { defineExtension } from "eve/extension";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";

/** What a Slack search tool is about to show the caller. */
export interface SlackSearchAccessRequest {
  readonly tool: "search" | "read_conversation" | "read_user";
  /** The turn's caller. */
  readonly auth: SessionAuthContext | null;
  /** The channel whose messages would be returned. Absent for `read_user`. */
  readonly channelId?: string;
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
  /** Slack API transport overrides, as in `slackChannel({ api })`. */
  readonly api?: SlackTransportOptions;
  /**
   * Decides which channels and user lookups each caller may see. Called for every channel a
   * tool would return messages from. Allows every public channel when omitted.
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
  api: z
    .custom<SlackTransportOptions>((value) => typeof value === "object" && value !== null)
    .optional(),
  authorize: z.custom<SlackSearchAuthorize>(isFunction, "authorize must be a function").optional(),
});

// Typed as a Standard Schema so the public declaration names eve's own config type instead of Zod's.
const config: StandardSchemaV1<SlackSearchExtensionConfig> = schema;

export default defineExtension({ config });

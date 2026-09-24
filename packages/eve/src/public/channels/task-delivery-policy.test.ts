import { expectTypeOf, it } from "vitest";

import type {
  ChannelSendOptions,
  SessionSendOptions,
  defineChannel,
} from "#public/channels/index.js";
import type { chatSdkChannel, ChatSdkSendOptions } from "#public/channels/chat-sdk/index.js";
import type { discordChannel } from "#public/channels/discord/index.js";
import type { eveChannel } from "#public/channels/eve.js";
import type { githubChannel } from "#public/channels/github/index.js";
import type { linearChannel } from "#public/channels/linear/index.js";
import type { linqChannel } from "#public/channels/linq/index.js";
import type { mcpChannel } from "#public/channels/mcp.js";
import type { photonIMessageChannel } from "#public/channels/photon/index.js";
import type {
  slackChannel,
  SlackSendOptions,
  SlackEventSendOptions,
} from "#public/channels/slack/index.js";
import type { teamsChannel } from "#public/channels/teams/index.js";
import type { telegramChannel } from "#public/channels/telegram/index.js";
import type { twilioChannel } from "#public/channels/twilio/index.js";
import type { ScheduleDefinition } from "#public/schedules/index.js";

it("exposes task delivery policy on sends, not channel or schedule definitions", () => {
  expectTypeOf<ChannelSendOptions>()
    .toHaveProperty("taskDeliveryPolicy")
    .toEqualTypeOf<"auto" | "cohort" | "auto-silent" | "cohort-silent" | undefined>();
  expectTypeOf<SessionSendOptions>()
    .toHaveProperty("taskDeliveryPolicy")
    .toEqualTypeOf<"auto" | "cohort" | "auto-silent" | "cohort-silent" | undefined>();
  expectTypeOf<ChatSdkSendOptions>()
    .toHaveProperty("taskDeliveryPolicy")
    .toEqualTypeOf<"auto" | "cohort" | "auto-silent" | "cohort-silent" | undefined>();
  expectTypeOf<SlackSendOptions>()
    .toHaveProperty("taskDeliveryPolicy")
    .toEqualTypeOf<"auto" | "cohort" | "auto-silent" | "cohort-silent" | undefined>();
  expectTypeOf<SlackEventSendOptions>()
    .toHaveProperty("taskDeliveryPolicy")
    .toEqualTypeOf<"auto" | "cohort" | "auto-silent" | "cohort-silent" | undefined>();
  expectTypeOf<Parameters<typeof defineChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof chatSdkChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof discordChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof eveChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof githubChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof linearChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof linqChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof mcpChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof photonIMessageChannel>[0]>().not.toHaveProperty(
    "taskDeliveryPolicy",
  );
  expectTypeOf<Parameters<typeof slackChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof teamsChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof telegramChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<Parameters<typeof twilioChannel>[0]>().not.toHaveProperty("taskDeliveryPolicy");
  expectTypeOf<ScheduleDefinition>().not.toHaveProperty("taskDeliveryPolicy");
});

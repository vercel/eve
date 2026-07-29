import type { ChannelSetupIntegration } from "./types.js";
import { runChannelSetup } from "./runner.js";
import { WizardCancelledError } from "../../step.js";

async function choosePortableCredentials(
  context: Parameters<ChannelSetupIntegration["setup"]>[0],
): Promise<"vercel-connect" | "environment" | "cancelled"> {
  if (context.presetPortableCredentials !== undefined) {
    return context.presetPortableCredentials ? "environment" : "vercel-connect";
  }
  try {
    return (await context.ui.prompter.select<"vercel" | "portable">({
      message: "How would you like to configure Slack?",
      options: [
        {
          value: "vercel",
          label: "Set up Vercel Connect",
          hint: "Sign in and link this project",
        },
        {
          value: "portable",
          label: "Use portable credentials",
          hint: "Read Slack tokens from environment variables",
        },
      ],
    })) === "portable"
      ? "environment"
      : "vercel-connect";
  } catch (error) {
    if (error instanceof WizardCancelledError) return "cancelled";
    throw error;
  }
}

/** Slack's channel-owned credential choice, provisioning, and scaffold behavior. */
export const SLACK_CHANNEL_SETUP: ChannelSetupIntegration = {
  kind: "slack",
  label: "Slack",
  hint: "Slack app mentions and DMs",
  async setup(context) {
    const credentials = await choosePortableCredentials(context);
    if (credentials === "cancelled") return { kind: "cancelled" };
    if (credentials === "vercel-connect" && context.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Slack setup.",
      );
    }

    const result = await runChannelSetup(
      context,
      credentials === "environment"
        ? { slackCredentials: "environment" }
        : {
            slackCredentials: "vercel-connect",
            ensureLinkedProject: "interactive-vercel-link",
          },
    );
    if (
      result.kind === "done" &&
      credentials === "environment" &&
      result.state.channels.includes("slack")
    ) {
      context.ui.nextSteps([
        "Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env.local (listed in .env.example).",
        "Configure your Slack app to send events to /eve/v1/slack on your public agent URL.",
      ]);
    }
    return result;
  },
};

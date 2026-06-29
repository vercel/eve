import {
  verifySlackRequest as verifySlackWebhookRequest,
  type SlackWebhookVerifier,
} from "#compiled/@chat-adapter/slack/webhook.js";

export type { SlackWebhookVerifier };

/** Verification inputs for Eve's Slack webhook route. */
export interface SlackVerifyOptions {
  readonly signingSecret: string | undefined;
  readonly webhookVerifier: SlackWebhookVerifier | undefined;
  readonly maxSkewSeconds?: number;
}

/** Verifies a Slack request with the Chat SDK webhook primitive. */
export async function verifySlackRequest(
  request: Request,
  options: SlackVerifyOptions,
): Promise<string> {
  if (options.webhookVerifier === undefined && !options.signingSecret) {
    throw new Error(
      "slackChannel: missing signing secret. Pass credentials.signingSecret, " +
        "set SLACK_SIGNING_SECRET, or supply credentials.webhookVerifier.",
    );
  }

  try {
    return await verifySlackWebhookRequest(request, options);
  } catch (error) {
    throw normalizeSlackWebhookError(error);
  }
}

function normalizeSlackWebhookError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("verifier rejected")) {
    return new Error("slackChannel: inbound webhook verifier rejected the request.");
  }
  if (message.includes("signature headers")) {
    return new Error("slackChannel: inbound request missing Slack signature headers.");
  }
  if (message.includes("timestamp is invalid")) {
    return new Error("slackChannel: inbound request has malformed timestamp.");
  }
  if (message.includes("timestamp is too old")) {
    return new Error("slackChannel: inbound request timestamp outside allowed skew.");
  }
  if (message.includes("signature is invalid")) {
    return new Error("slackChannel: inbound request signature mismatch.");
  }
  return error instanceof Error ? error : new Error(message);
}

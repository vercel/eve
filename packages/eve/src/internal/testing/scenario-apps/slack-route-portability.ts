import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const SLACK_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/slack.ts": `import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  botName: "testbot",
  onBlockActions(interaction, ctx) {
    const actionId: string | undefined = interaction.actions[0]?.actionId;
    const raw: Readonly<Record<string, unknown>> | undefined = interaction.actions[0]?.raw;
    void ctx.message?.cancel();
    void [actionId, raw];
  },
  onInteraction(interaction, ctx) {
    const payload: Readonly<Record<string, unknown>> = interaction.payload;
    const type: string = interaction.type;
    const userId: string | undefined = interaction.user?.id;
    const teamId: string | undefined = interaction.teamId;
    const installationTeamId: string | undefined = interaction.installationTeamId;
    const enterpriseId: string | undefined = interaction.enterpriseId;
    ctx.waitUntil(Promise.resolve());
    void ctx.slack.request("auth.test", {});
    void [payload, type, userId, teamId, installationTeamId, enterpriseId];
    return Response.json({ ok: true });
  },
});
`,
  },
  name: "slack-route-portability",
};

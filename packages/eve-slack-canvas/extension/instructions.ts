import { defineDynamic, defineInstructions } from "eve/instructions";

import extension from "./extension.ts";
import { loadSlackCanvas } from "./lib/canvas.ts";

export default defineDynamic(async (ctx) => {
  const { channelName, workspaces } = extension.config;
  if (!ctx.turn || ctx.channel.kind !== `channel:${channelName}`) return null;

  const { installationTeamId, channelId } = ctx.channel.metadata;
  if (typeof installationTeamId !== "string" || typeof channelId !== "string") return null;
  const workspace = Object.hasOwn(workspaces, installationTeamId)
    ? workspaces[installationTeamId]
    : undefined;
  if (!workspace || !Object.hasOwn(workspace.channels, channelId)) return null;
  const canvasId = workspace.channels[channelId];

  const text = await ctx.memo([ctx.turn.id, installationTeamId, channelId, canvasId], async () => {
    const token = process.env[workspace.botTokenEnv];
    if (!token) return null;
    return await loadSlackCanvas(canvasId, token);
  });
  return text ? defineInstructions({ content: `Slack channel guidance:\n\n${text}` }) : null;
});

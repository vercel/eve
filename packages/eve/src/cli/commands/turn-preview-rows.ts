import type { SessionAuthContext } from "#channel/types.js";
import type { CliRow } from "#cli/ui/output.js";
import type { TurnPreview } from "#services/turn-preview.js";

export function renderTurnPreviewRows(preview: TurnPreview): CliRow[] {
  return [
    { label: "Auth", value: formatAuth(preview.auth) },
    {
      label: "Channel",
      value: preview.channel.name ?? preview.channel.kind,
    },
    {
      label: "Tools",
      tone: preview.tools.length === 0 ? "warning" : "default",
      value:
        preview.tools.length === 0
          ? "none"
          : preview.tools
              .map(
                (tool) =>
                  `${tool.name} (${tool.source}${tool.deferred ? ", reached through tool search" : ""})`,
              )
              .join("\n"),
    },
    ...(preview.hiddenTools.length === 0
      ? []
      : [
          {
            label: "Hidden Tools",
            tone: "warning" as const,
            value: preview.hiddenTools
              .map((tool) => `${tool.name} (${tool.source}): ${tool.reason}`)
              .join("\n"),
          },
        ]),
    {
      label: "Connections",
      value:
        preview.connections.length === 0
          ? "none"
          : preview.connections
              .map((connection) => `${connection.name} (${connection.protocol})`)
              .join("\n"),
    },
  ];
}

export function renderTurnPreviewInstructions(preview: TurnPreview): string {
  return [...preview.instructions.system, ...preview.instructions.context]
    .filter((text) => text.trim() !== "")
    .join("\n\n---\n\n");
}

export function formatAuth(auth: SessionAuthContext | null): string {
  if (auth === null) return "anonymous";
  const groups = auth.attributes.groups;
  const groupList = groups === undefined ? "" : ` groups=${[groups].flat().join(",")}`;
  return `${auth.principalType} ${auth.principalId} (authenticator ${auth.authenticator})${groupList}`;
}

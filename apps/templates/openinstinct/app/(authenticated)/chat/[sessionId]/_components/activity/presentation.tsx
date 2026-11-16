import type { SubagentStatus } from "@app/_lib/subagent-sessions";
import { Badge } from "@web/components/ui/badge";

export function agentLabel(name: string) {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export function StatusIndicator({
  status,
}: {
  readonly status: SubagentStatus;
}) {
  const variant =
    status === "working" || status === "starting"
      ? "information"
      : status === "failed"
        ? "destructive"
        : status === "cancelled"
          ? "secondary"
          : "success";

  return <Badge variant={variant}>{status}</Badge>;
}

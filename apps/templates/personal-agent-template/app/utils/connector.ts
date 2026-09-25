import type { ConnectorState, ParsedTestResult } from "#shared/types/connector";

export function getFetchErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data;
    if (data?.message) {
      return data.message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong";
}

export function connectorStatusLabel(state: ConnectorState) {
  switch (state) {
    case "connected":
      return { label: "Connected", color: "success" as const };
    case "installation_required":
      return { label: "Install required", color: "warning" as const };
    case "setup_required":
      return { label: "Setup required", color: "warning" as const };
    case "error":
      return { label: "Error", color: "error" as const };
    default:
      return { label: "Not connected", color: "neutral" as const };
  }
}

export function isCliHintLine(line: string) {
  return line.startsWith("vercel ") || line.startsWith("Update ");
}

export function parseTestResult(line: string): ParsedTestResult {
  const withId = line.match(/^([A-Z]+-\d+)\s*[—-]\s*(.+)$/);
  if (withId?.[1] && withId[2]) {
    return { id: withId[1], title: withId[2] };
  }

  const withTag = line.match(/^(\[[^\]]+\])\s*(.+)$/);
  if (withTag?.[1] && withTag[2]) {
    return { tag: withTag[1].slice(1, -1), title: withTag[2] };
  }

  return { title: line };
}

export function testResultsHeading(connectorId: string) {
  if (connectorId === "linear") {
    return "Issues";
  }
  if (connectorId === "github") {
    return "Repositories";
  }
  return "Results";
}

const CONNECTION_ICONS: Record<string, string> = {
  linear: "i-simple-icons-linear",
  github: "i-simple-icons-github",
  slack: "i-simple-icons-slack",
};

export function connectionIcon(name: string) {
  return CONNECTION_ICONS[name.toLowerCase()] ?? "i-lucide-plug";
}

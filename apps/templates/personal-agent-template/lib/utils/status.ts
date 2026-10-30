import type { ConnectorStatus } from "../types/connector";

export function getSetupStatus(status: ConnectorStatus) {
  return status.state === "setup_required" ? status : undefined;
}

export function getErrorStatus(status: ConnectorStatus) {
  return status.state === "error" ? status : undefined;
}

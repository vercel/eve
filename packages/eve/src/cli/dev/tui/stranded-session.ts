import { ClientSessionStrandedError } from "#client/client-error.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export function formatStrandedSessionNotice(
  error: unknown,
  input: { readonly localServer: boolean; readonly sessionId: string | undefined },
): string | undefined {
  if (!(error instanceof ClientSessionStrandedError)) return undefined;
  const versions = [
    error.eveVersion === undefined ? undefined : `built by eve ${error.eveVersion}`,
    input.localServer
      ? `this dev server runs eve ${resolveInstalledPackageInfo().version}`
      : undefined,
  ].filter((part) => part !== undefined);
  const detail = versions.length === 0 ? "" : ` (${versions.join("; ")})`;
  const session = `Session ${input.sessionId ?? "unknown"}`;
  return `${session} is stranded${detail}: the deployment that ran it is no longer available. The session cannot continue. Run /new to end it and start a fresh session.`;
}

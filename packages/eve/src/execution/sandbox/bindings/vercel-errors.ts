import { walkCauseChain } from "#shared/errors.js";

const INTERRUPTED_COMMAND_STREAM_CODES = new Set([
  "sandbox_stream_closed",
  "stream_ended_early",
  "UND_ERR_SOCKET",
]);

/** Whether a submitted command lost the transport carrying its output or completion. */
export function isVercelCommandStreamInterruptedError(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    const code = (candidate as { readonly code?: unknown }).code;
    if (typeof code === "string" && INTERRUPTED_COMMAND_STREAM_CODES.has(code)) {
      return true;
    }
  }
  return error instanceof TypeError && error.message === "terminated";
}

export function isVercelSnapshotUnavailableError(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    if (status === 410) {
      return true;
    }
  }

  return false;
}

export function isVercelSandboxMissingError(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    if (status === 404) {
      return true;
    }
  }

  return false;
}

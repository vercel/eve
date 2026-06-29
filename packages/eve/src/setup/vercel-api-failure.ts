import type { VercelCaptureFailure, VercelCaptureResult } from "#setup/primitives/index.js";
import { z } from "zod";

const VercelApiErrorSchema = z.object({
  error: z
    .object({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().optional(),
    })
    .optional(),
});

function apiErrorFromStdout(stdout: string) {
  try {
    const parsed = VercelApiErrorSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

function apiFailureText(failure: VercelCaptureFailure): string {
  const error = apiErrorFromStdout(failure.stdout);
  return `${String(error?.code ?? "")} ${error?.message ?? ""} ${failure.stderr}`.toLowerCase();
}

/** Treats a structured API error as a failure even when `vercel api --raw` exits zero. */
export function normalizeVercelApiResult(result: VercelCaptureResult): VercelCaptureResult {
  if (!result.ok) return result;
  const error = apiErrorFromStdout(result.stdout);
  if (error === undefined) return result;

  const detail = error.message ?? (error.code === undefined ? undefined : String(error.code));
  return {
    ok: false,
    failure: {
      stdout: result.stdout,
      stderr: "",
      message: `Vercel API request failed${detail === undefined ? "" : `: ${detail}`}.`,
    },
  };
}

/** Whether a Vercel API failure proves that the requested resource does not exist. */
export function isNotFoundApiFailure(failure: VercelCaptureFailure): boolean {
  return /(^|\W)(404|not_found)(\W|$)|not found/.test(apiFailureText(failure));
}

/** Whether a Vercel API failure proves that the requested resource already exists. */
export function isConflictApiFailure(failure: VercelCaptureFailure): boolean {
  return /(^|\W)(409|conflict)(\W|$)|already exists/.test(apiFailureText(failure));
}

/** Whether a scoped Vercel API request was denied. */
export function isForbiddenApiFailure(failure: VercelCaptureFailure): boolean {
  return /(^|\W)(403|forbidden|not_authorized|team_unauthorized|sso|saml)(\W|$)|not authorized/.test(
    apiFailureText(failure),
  );
}

import { toErrorMessage } from "#shared/errors.js";
import type {
  MicrosandboxError,
  MicrosandboxErrorCode,
  PullProgressEvent,
  Sandbox as MicrosandboxSandbox,
  SandboxBuilder as MicrosandboxSandboxBuilder,
} from "microsandbox";

type MicrosandboxCreatePhase =
  | "resolving the image"
  | "downloading and materializing image layers"
  | "assembling the image filesystem"
  | "image ready; booting microsandbox VM";

export async function createMicrosandboxWithProgress(input: {
  readonly builder: MicrosandboxSandboxBuilder;
  readonly errorType: typeof MicrosandboxError;
  readonly log?: (message: string) => void;
  readonly source: string;
}): Promise<MicrosandboxSandbox> {
  const progress = { phase: "resolving the image" as MicrosandboxCreatePhase };

  try {
    const creation = await input.builder.createWithPullProgress();
    const progressReporter = reportMicrosandboxCreateProgress(creation, progress, input.log);
    try {
      return await withHeartbeat(progress, input.log, async () => await creation.awaitSandbox());
    } finally {
      await progressReporter.catch(() => {});
    }
  } catch (error) {
    throw enrichMicrosandboxError({
      context: `Failed to create microsandbox VM from ${input.source} while ${progress.phase}`,
      error,
      errorType: input.errorType,
    });
  }
}

export function enrichMicrosandboxError(input: {
  readonly context: string;
  readonly error: unknown;
  readonly errorType?: typeof MicrosandboxError;
}): Error {
  if (input.error instanceof MicrosandboxDiagnosticError) {
    return input.error;
  }

  const code = readMicrosandboxErrorCode(input.error, input.errorType);
  const codeLabel = code === undefined ? "" : ` [${code}]`;
  const detail = toErrorMessage(input.error);
  const detailSentence = /[.!?]$/u.test(detail) ? detail : `${detail}.`;
  return new MicrosandboxDiagnosticError(`${input.context}${codeLabel}: ${detailSentence}`, {
    cause: input.error,
    hint: microsandboxErrorHint(code),
  });
}

class MicrosandboxDiagnosticError extends Error {
  /** Structured per-error-code remediation, surfaced by the semantic-error catalog. */
  readonly hint?: string;

  constructor(message: string, options?: ErrorOptions & { hint?: string }) {
    super(message, options);
    // Stable discriminator for the semantic-error catalog's sandbox rules;
    // subclassing alone leaves `name` as "Error".
    this.name = "MicrosandboxDiagnosticError";
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}

async function reportMicrosandboxCreateProgress(
  events: AsyncIterable<PullProgressEvent>,
  progress: { phase: MicrosandboxCreatePhase },
  log: ((message: string) => void) | undefined,
): Promise<void> {
  for await (const event of events) {
    const nextPhase = microsandboxCreatePhase(event, progress.phase);
    if (nextPhase === progress.phase) {
      continue;
    }
    progress.phase = nextPhase;
    log?.(nextPhase);
  }
}

function microsandboxCreatePhase(
  event: PullProgressEvent,
  currentPhase: MicrosandboxCreatePhase,
): MicrosandboxCreatePhase {
  switch (event.kind) {
    case "resolving":
    case "resolved":
      return "resolving the image";
    case "layerDownloadProgress":
    case "layerDownloadComplete":
    case "layerDownloadVerifying":
    case "layerMaterializeStarted":
    case "layerMaterializeProgress":
    case "layerMaterializeWriting":
    case "layerMaterializeComplete":
      return "downloading and materializing image layers";
    case "stitchMergingTrees":
    case "stitchWritingFsmeta":
    case "stitchWritingVmdk":
    case "stitchComplete":
      return "assembling the image filesystem";
    case "complete":
      return "image ready; booting microsandbox VM";
    default:
      return currentPhase;
  }
}

async function withHeartbeat<T>(
  progress: { readonly phase: MicrosandboxCreatePhase },
  log: ((message: string) => void) | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  log?.(progress.phase);
  if (log === undefined) {
    return await callback();
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    log(`${progress.phase} (${elapsedSeconds}s elapsed)`);
  }, 10_000);
  timer.unref?.();

  try {
    return await callback();
  } finally {
    clearInterval(timer);
  }
}

// Recovery guidance keyed by error code, and the single source of truth
// for which microsandbox codes we recognize: only codes with guidance
// are trusted when duck-typing (see `readMicrosandboxErrorCode`).
const MICROSANDBOX_ERROR_HINTS: Partial<Record<MicrosandboxErrorCode, string>> = {
  database:
    "Check that the microsandbox npm package and installed VM runtime use the same version. If versions changed, use a clean MSB_HOME or migrate the existing database.",
  imageNotFound: "Check that the image exists and that the registry credentials can pull it.",
  libkrunfwNotFound:
    "Run `npx microsandbox install` and verify that MSB_PATH points to the installed runtime.",
};

function readMicrosandboxErrorCode(
  error: unknown,
  errorType: typeof MicrosandboxError | undefined,
): MicrosandboxErrorCode | undefined {
  if (errorType !== undefined && error instanceof errorType) {
    return error.code;
  }
  // Without the module's error class we can only duck-type. Trust a
  // `code` string only when it names a code we have guidance for, so a
  // generic Node error (e.g. ENOENT) surfacing during prewarm is not
  // mislabeled as a microsandbox code.
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(MICROSANDBOX_ERROR_HINTS, error.code)
  ) {
    return error.code as MicrosandboxErrorCode;
  }
  return undefined;
}

function microsandboxErrorHint(code: MicrosandboxErrorCode | undefined): string | undefined {
  return code === undefined ? undefined : MICROSANDBOX_ERROR_HINTS[code];
}

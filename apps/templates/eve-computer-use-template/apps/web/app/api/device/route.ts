import { experimental_decide as decide } from "ai";

import { getViewer } from "../../../lib/session";
import { enforceRateLimit, RateLimitError } from "../../../lib/rate-limit";
import { isSameOrigin } from "../caller";

import {
  DEFAULT_DEVICE,
  DEVICES,
  isDeviceName,
  type DeviceName,
} from "../../../../../agent/lib/devices";

export const dynamic = "force-dynamic";

/** Longest request body read, and longest task passed to `decide`. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TASK_LENGTH = 4000;
const DECIDE_TIMEOUT_MS = 10_000;
/** Each viewer's Auto decisions an hour, when Upstash is configured; see lib/rate-limit.ts. */
const DECISIONS_PER_HOUR = 120;
/** Baseten's 9B decision model, through Vercel AI Gateway. */
const DECISION_MODEL = "baseten/elephant-1";

/**
 * Auto mode: `POST /api/device` with `{ "task": "…" }` answers `{ "device": "browser" | "desktop" }`,
 * the device better suited to the task, chosen with the AI SDK's `decide` and a Baseten decision
 * model. It runs in the web app, outside any eve session, so it uses the AI SDK directly rather than
 * `decide` from eve/ai, which records usage on the session and brings eve's server runtime with it. When the decision fails or
 * times out, it answers the default device with `"fallback": true`, so a chat always starts.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return Response.json({ error: "Cross-site requests are refused." }, { status: 403 });
  // Each decision is a model call billed to the project, so only a signed-in viewer gets one,
  // and, with Upstash configured, only so many an hour.
  const viewer = getViewer(request.headers);
  if (viewer === null) return Response.json({ error: "Sign in first." }, { status: 401 });
  try {
    await enforceRateLimit({
      key: viewer.id,
      limit: DECISIONS_PER_HOUR,
      prefix: "device",
      windowSeconds: 60 * 60,
    });
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    return Response.json(
      { error: error.message },
      { headers: { "retry-after": String(error.retryAfter) }, status: 429 },
    );
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES)
    return Response.json({ error: "The task is too long." }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { task?: unknown } | null;
  const task = typeof body?.task === "string" ? body.task.trim().slice(0, MAX_TASK_LENGTH) : "";
  if (task.length === 0)
    return Response.json({ error: 'Expected a JSON body like { "task": "…" }.' }, { status: 400 });

  try {
    const { answers } = await decide({
      model: DECISION_MODEL,
      state: { task },
      questions: {
        device: {
          type: "choice",
          instructions:
            "Pick the device in the agent's sandbox that can best carry out the user's task.",
          criteria: {
            browser: DEVICES.browser.criteria,
            desktop: DEVICES.desktop.criteria,
          },
        },
      },
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(DECIDE_TIMEOUT_MS)]),
    });
    const device: DeviceName = isDeviceName(answers.device.choice)
      ? answers.device.choice
      : DEFAULT_DEVICE;
    return Response.json({ device });
  } catch (error) {
    console.warn("Choosing a device failed; using the default:", error);
    return Response.json({ device: DEFAULT_DEVICE, fallback: true });
  }
}

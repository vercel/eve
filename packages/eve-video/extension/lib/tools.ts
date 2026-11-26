import type { ApprovalConfiguration, ApprovalPromptContext } from "eve/tools/approval";
import { z } from "zod";

import { describeDefaultModel } from "./model.ts";
import type * as t from "./types.ts";

const str = () => z.string().trim().min(1);

export const VIDEO_TOOL_DESCRIPTION =
  "Generate a video from a text prompt, optionally guided by start/end frames or references, or edit/extend an existing video via video and mode. Only call when explicitly requested (video generation takes seconds to minutes and incurs per-second charges). Runs in the background as a task and delivers the result automatically; do not sleep, poll, or regenerate while it runs. Do not combine video with start or end. Omit model to use the default unless explicitly asked.";

export const generateVideoInputSchema = z.object({
  prompt: str().describe("Visual description of the video to generate, edit, or extend."),
  video: str()
    .optional()
    .describe("Existing video to edit/extend (https:// URL, storageKey, or sandbox path)."),
  mode: z
    .enum(["edit", "extend"])
    .optional()
    .describe('Operation for video: "edit" (default) or "extend". Requires video.'),
  start: str().optional().describe("Opening frame image (https:// URL or sandbox path)."),
  end: str().optional().describe("Closing frame image (https:// URL or sandbox path)."),
  references: z
    .array(str())
    .min(1)
    .optional()
    .describe("Reference images, videos, or audio clips."),
  duration: z.number().positive().optional().describe("Target duration in seconds."),
  aspectRatio: str().optional().describe('Aspect ratio such as "16:9", "9:16", "1:1", or "auto".'),
  resolution: str()
    .optional()
    .describe('Resolution: "480p", "720p", "1080p", "4k", or "1280x720".'),
  audio: z.boolean().optional().describe("Generate synchronized audio alongside the video."),
  n: z.number().int().min(1).optional().describe("Number of video variations. Defaults to 1."),
  fps: z.number().positive().optional().describe("Target frame rate in frames per second."),
  seed: z.number().int().optional().describe("Deterministic integer seed when supported."),
  model: str().optional().describe("Model ID or alias from configured models. Omit for default."),
  path: str().optional().describe("Sandbox file path where the generated video should be written."),
});

export function createGenerateApproval(
  getConfig: () => t.VideoExtensionConfig,
): ApprovalConfiguration<t.GenerateVideoToolInput> {
  return {
    request(ctx) {
      const a = getConfig().approval;
      return a === undefined ? "not-applicable" : typeof a === "function" ? a(ctx) : a.request(ctx);
    },
    prompt(ctx) {
      const a = getConfig().approval;
      return typeof a === "object" && a !== null && a.prompt
        ? a.prompt(ctx)
        : formatApprovalPrompt(getConfig(), ctx);
    },
    get response() {
      const a = getConfig().approval;
      return typeof a === "object" && a !== null ? a.response : undefined;
    },
  };
}

export const formatGenerateProgressLabel = (
  p: Readonly<t.GenerateVideoToolProgress | t.GenerateVideoToolOutput>,
): string =>
  p.status === "completed"
    ? countLabel(p.videos.length)
    : p.elapsedSeconds > 0
      ? `Generating video (${p.elapsedSeconds}s)`
      : "Generating video";

export const formatGenerateCompleteLabel = (
  o: Readonly<t.GenerateVideoToolProgress | t.GenerateVideoToolOutput>,
): string => (o.status === "completed" ? countLabel(o.videos.length) : "Generated video");

const countLabel = (n: number) => (n === 1 ? "Generated video" : `Generated ${n} videos`);

function formatApprovalPrompt(
  config: t.VideoExtensionConfig,
  { input }: ApprovalPromptContext<t.GenerateVideoToolInput>,
): string {
  const action =
    input.video === undefined
      ? "Generate video"
      : input.mode === "extend"
        ? "Extend video"
        : "Edit video";
  const def = config.defaults;
  const dur = input.duration ?? def?.duration;
  const audio = input.audio ?? def?.audio;
  const details = [
    input.video !== undefined ? `video: ${input.video.trim()}` : "",
    dur !== undefined ? `${dur}s` : "",
    input.aspectRatio ?? def?.aspectRatio ?? "",
    input.resolution ?? def?.resolution ?? "",
    audio !== undefined ? (audio ? "audio" : "silent") : "",
    input.n !== undefined && input.n > 1 ? `${input.n} videos` : "",
    input.path !== undefined ? `path: ${input.path}` : "",
  ].filter(Boolean);
  const trimmed = input.prompt.trim();
  const promptText = trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 297)}...`;
  return `${action} with ${describeDefaultModel(config, input.model)}${details.length ? ` (${details.join(", ")})` : ""}: "${promptText}"`;
}

import type {
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalPromptContext,
} from "eve/tools/approval";
import { z } from "zod";

import { describeDefaultModel } from "./model.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
  VideoExtensionConfig,
} from "./types.ts";

const MAX_APPROVAL_PROMPT_CHARS = 300;

export const VIDEO_TOOL_DESCRIPTION = [
  "Generate a video from a text prompt, optionally guided by start and end frame images or reference images, videos, or audio clips, or edit or extend an existing video via video and mode.",
  "Only call this tool when the user explicitly asks for a video; video generation takes tens of seconds to several minutes and incurs per-second model charges.",
  "Runs in the background as a task and delivers the finished video automatically when complete; do not sleep, poll, or regenerate the same video while it runs.",
  "Do not combine video with start or end frames, and avoid combining start or end frames with references on models that ignore references when frame images are set.",
  "Omit model to use the default unless the user explicitly asks for a configured model.",
].join(" ");

export const generateVideoInputSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Detailed description of the video to generate, or the edit or continuation to apply to video: subject, action, camera movement, lighting, style, and sound or dialogue when audio is enabled.",
    ),
  video: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional existing video to edit or extend: pass an https:// URL, a storageKey from an earlier generation, or a sandbox file path. Cannot be combined with start or end.",
    ),
  mode: z
    .enum(["edit", "extend"])
    .optional()
    .describe(
      'How to use video: "edit" (default when video is provided) modifies the existing video according to prompt; "extend" continues from its last frame. Requires video.',
    ),
  start: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional starting frame image as an https:// URL or sandbox file path."),
  end: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional ending frame image as an https:// URL or sandbox file path."),
  references: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Optional reference images, videos, or audio clips as https:// URLs or sandbox file paths for character, style, or motion guidance.",
    ),
  duration: z.number().positive().optional().describe("Requested video duration in seconds."),
  aspectRatio: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Requested aspect ratio such as "16:9", "9:16", "1:1", or "auto".'),
  resolution: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Requested output resolution such as "480p", "720p", "1080p", "4k", or "1280x720".'),
  audio: z
    .boolean()
    .optional()
    .describe("Whether to generate synchronized audio alongside the video."),
  n: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Number of video variations to generate. Defaults to 1."),
  fps: z.number().positive().optional().describe("Target frame rate in frames per second."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Deterministic integer seed for reproducible generation when supported."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional model ID or alias from the configured models catalog. Omit to use the default model.",
    ),
  path: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional sandbox file path where the generated video should be written."),
});

export function createGenerateApproval(
  getConfig: () => VideoExtensionConfig,
): ApprovalConfiguration<GenerateVideoToolInput> {
  return {
    request(ctx: ApprovalContext<GenerateVideoToolInput>) {
      const configured = getConfig().approval;
      if (configured === undefined) return "not-applicable";
      return typeof configured === "function" ? configured(ctx) : configured.request(ctx);
    },
    prompt(ctx: ApprovalPromptContext<GenerateVideoToolInput>) {
      const configured = getConfig().approval;
      if (
        typeof configured === "object" &&
        configured !== null &&
        configured.prompt !== undefined
      ) {
        return configured.prompt(ctx);
      }
      return formatApprovalPrompt(getConfig(), ctx);
    },
    get response() {
      const configured = getConfig().approval;
      return typeof configured === "object" && configured !== null
        ? configured.response
        : undefined;
    },
  };
}

export function formatGenerateProgressLabel(
  partial: Readonly<GenerateVideoToolProgress | GenerateVideoToolOutput>,
): string {
  if (partial.status === "completed") {
    return formatCompletedCount(partial.videos.length);
  }
  return partial.elapsedSeconds > 0
    ? `Generating video (${partial.elapsedSeconds}s)`
    : "Generating video";
}

export function formatGenerateCompleteLabel(
  output: Readonly<GenerateVideoToolProgress | GenerateVideoToolOutput>,
): string {
  return output.status === "completed"
    ? formatCompletedCount(output.videos.length)
    : "Generated video";
}

function formatCompletedCount(count: number): string {
  return count === 1 ? "Generated video" : `Generated ${count} videos`;
}

function formatApprovalPrompt(
  config: VideoExtensionConfig,
  ctx: ApprovalPromptContext<GenerateVideoToolInput>,
): string {
  const { input } = ctx;
  const modelLabel = describeDefaultModel(config, input.model);
  const action =
    input.video === undefined
      ? "Generate video"
      : input.mode === "extend"
        ? "Extend video"
        : "Edit video";
  const details: string[] = [];
  if (input.video !== undefined) details.push(`video: ${input.video.trim()}`);
  const duration = input.duration ?? config.defaults?.duration;
  const aspectRatio = input.aspectRatio ?? config.defaults?.aspectRatio;
  const resolution = input.resolution ?? config.defaults?.resolution;
  const audio = input.audio ?? config.defaults?.audio;
  if (duration !== undefined) details.push(`${duration}s`);
  if (aspectRatio !== undefined) details.push(aspectRatio);
  if (resolution !== undefined) details.push(resolution);
  if (audio !== undefined) details.push(audio ? "audio" : "silent");
  if (input.n !== undefined && input.n > 1) details.push(`${input.n} videos`);
  if (input.path !== undefined) details.push(`path: ${input.path}`);
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";
  const trimmed = input.prompt.trim();
  const promptText =
    trimmed.length <= MAX_APPROVAL_PROMPT_CHARS
      ? trimmed
      : `${trimmed.slice(0, MAX_APPROVAL_PROMPT_CHARS - 3)}...`;
  return `${action} with ${modelLabel}${detailText}: "${promptText}"`;
}

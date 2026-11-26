import { createHash } from "node:crypto";

import { defineTool, toolOutput, type ToolDefinition } from "eve/tools";
import type {
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalPromptContext,
} from "eve/tools/approval";
import { z } from "zod";

import { generateVideos } from "./engine.ts";
import { describeDefaultModel } from "./model.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
  VideoExtensionConfig,
} from "./types.ts";

const MAX_APPROVAL_PROMPT_CHARS = 300;

const VIDEO_TOOL_DESCRIPTION = [
  "Generate a video from a text prompt, optionally guided by start and end frame images or reference images, videos, or audio clips.",
  "Only call this tool when the user explicitly asks for a video; video generation takes tens of seconds to several minutes and incurs per-second model charges.",
  "Do not combine start or end frames with references on providers that ignore references when frame images are set.",
  "Omit model to use the default unless the user explicitly asks for a configured model.",
].join(" ");

export const generateVideoInputSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Detailed description of the video to generate: subject, action, camera movement, lighting, style, and sound or dialogue when audio is enabled.",
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

export function defineGenerateVideoTool(
  getConfig: () => VideoExtensionConfig,
): ToolDefinition<GenerateVideoToolInput, GenerateVideoToolProgress | GenerateVideoToolOutput> {
  const approval: ApprovalConfiguration<GenerateVideoToolInput> = {
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

  const definition: ToolDefinition<
    GenerateVideoToolInput,
    GenerateVideoToolProgress | GenerateVideoToolOutput
  > = {
    description: VIDEO_TOOL_DESCRIPTION,
    inputSchema: generateVideoInputSchema,
    approval,
    label: {
      start: () => "Generating video",
      delta: (_input, partial) => formatProgressLabel(partial),
      complete: (_input, output) =>
        output.status === "completed"
          ? formatCompletedCount(output.videos.length)
          : "Generated video",
    },
    async *execute(input, ctx) {
      const output = yield* generateVideos({
        config: getConfig(),
        input,
        getSandbox: () => ctx.getSandbox(),
        sessionId: ctx.session.id,
        idempotencyKey: createHash("sha256")
          .update(`${ctx.session.id}:${ctx.callId}`)
          .digest("hex"),
        signal: ctx.abortSignal,
      });
      yield output;
      return output;
    },
    toModelOutput(output) {
      return toolOutput.json(output);
    },
  };

  return defineTool(definition);
}

function formatCompletedCount(count: number): string {
  return count === 1 ? "Generated video" : `Generated ${count} videos`;
}

function formatProgressLabel(
  partial: Readonly<GenerateVideoToolProgress | GenerateVideoToolOutput>,
): string {
  switch (partial.status) {
    case "starting":
      return "Starting video generation";
    case "generating":
      return partial.elapsedSeconds > 0
        ? `Generating video (${partial.elapsedSeconds}s)`
        : "Generating video";
    case "saving":
      return partial.videoCount === 1 ? "Saving video" : `Saving ${partial.videoCount} videos`;
    case "completed":
      return formatCompletedCount(partial.videos.length);
  }
}

function formatApprovalPrompt(
  config: VideoExtensionConfig,
  ctx: ApprovalPromptContext<GenerateVideoToolInput>,
): string {
  const { input } = ctx;
  const modelLabel = describeDefaultModel(config, input.model);
  const details: string[] = [];
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
  return `Generate video with ${modelLabel}${detailText}: "${promptText}"`;
}

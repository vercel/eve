import type {
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
} from "#public/sandbox/vercel-image-sandbox.js";

export type ExperimentalVercelReusedImageEnvironmentOptions =
  ExperimentalVercelImageEnvironmentOptions &
    ExperimentalVercelImageRuntimeOptions & {
      readonly key: string;
    };

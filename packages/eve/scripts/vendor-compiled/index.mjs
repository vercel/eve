/**
 * Aggregates every per-package config in this directory into the flat list
 * the orchestrator passes to `runVendor`. Adding a new vendored package
 * means writing a new per-package file and importing it here.
 */
import anthropic from "./@ai-sdk/anthropic.mjs";
import google from "./@ai-sdk/google.mjs";
import mcp from "./@ai-sdk/mcp.mjs";
import openai from "./@ai-sdk/openai.mjs";
import otel from "./@ai-sdk/otel.mjs";
import provider from "./@ai-sdk/provider.mjs";

import chatAdapterSlack from "./@chat-adapter/slack.mjs";
import chatAdapterStateMemory from "./@chat-adapter/state-memory.mjs";

import opentelemetryApi from "./@opentelemetry/api.mjs";
import standardSchemaSpec from "./@standard-schema/spec.mjs";
import vercelDetectAgent from "./@vercel/detect-agent.mjs";
import vercelOidc from "./@vercel/oidc.mjs";
import vercelSandbox from "./@vercel/sandbox.mjs";
import workflowCore from "./@workflow/core.mjs";
import workflowErrors from "./@workflow/errors.mjs";
import workflowWorld from "./@workflow/world.mjs";

import chat from "./chat.mjs";
import chokidar from "./chokidar.mjs";
import commander from "./commander.mjs";
import experimentalAiSdkCodeMode from "./experimental-ai-sdk-code-mode.mjs";
import grayMatter from "./gray-matter.mjs";
import jose from "./jose.mjs";
import jsoncParser from "./jsonc-parser.mjs";
import picocolors from "./picocolors.mjs";
import semver from "./semver.mjs";
import turndown from "./turndown.mjs";
import zod from "./zod.mjs";
import zodValidationError from "./zod-validation-error.mjs";

export const MODULES = [
  anthropic,
  chat,
  chatAdapterSlack,
  chatAdapterStateMemory,
  chokidar,
  commander,
  experimentalAiSdkCodeMode,
  google,
  grayMatter,
  jose,
  jsoncParser,
  mcp,
  openai,
  opentelemetryApi,
  otel,
  picocolors,
  provider,
  semver,
  standardSchemaSpec,
  turndown,
  vercelDetectAgent,
  vercelOidc,
  vercelSandbox,
  workflowCore,
  workflowErrors,
  workflowWorld,
  zod,
  zodValidationError,
];

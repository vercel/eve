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
import providerUtils from "./@ai-sdk/provider-utils.mjs";

import chatAdapterSlack from "./@chat-adapter/slack.mjs";
import chatAdapterStateMemory from "./@chat-adapter/state-memory.mjs";
import chatAdapterTwilio from "./@chat-adapter/twilio.mjs";

import opentelemetryApi from "./@opentelemetry/api.mjs";
import standardSchemaSpec from "./@standard-schema/spec.mjs";
import vercelDetectAgent from "./@vercel/detect-agent.mjs";
import vercelOidc from "./@vercel/oidc.mjs";
import vercelSandbox from "./@vercel/sandbox.mjs";
import workflowCore from "./@workflow/core.mjs";
import workflowErrors from "./@workflow/errors.mjs";
import workflowSerde from "./@workflow/serde.mjs";
import workflowWorld from "./@workflow/world.mjs";
import workflowWorldLocal from "./@workflow/world-local.mjs";
import workflowWorldVercel from "./@workflow/world-vercel.mjs";

import chat from "./chat.mjs";
import chokidar from "./chokidar.mjs";
import commander from "./commander.mjs";
import experimentalAiSdkCodeMode from "./experimental-ai-sdk-code-mode.mjs";
import eventsourceParserStream from "./eventsource-parser-stream.mjs";
import envRunner from "./env-runner.mjs";
import grayMatter from "./gray-matter.mjs";
import jose from "./jose.mjs";
import jsoncParser from "./jsonc-parser.mjs";
import jsonSchema from "./json-schema.mjs";
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
  chatAdapterTwilio,
  chokidar,
  commander,
  experimentalAiSdkCodeMode,
  eventsourceParserStream,
  envRunner,
  google,
  grayMatter,
  jose,
  jsoncParser,
  jsonSchema,
  mcp,
  openai,
  opentelemetryApi,
  otel,
  picocolors,
  provider,
  providerUtils,
  semver,
  standardSchemaSpec,
  turndown,
  vercelDetectAgent,
  vercelOidc,
  vercelSandbox,
  workflowCore,
  workflowErrors,
  workflowSerde,
  workflowWorld,
  workflowWorldLocal,
  workflowWorldVercel,
  zod,
  zodValidationError,
];

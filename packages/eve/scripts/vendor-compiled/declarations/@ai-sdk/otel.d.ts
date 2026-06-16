import type { Telemetry } from "ai";

export interface OpenTelemetryOptions {
  tracer?: unknown;
  usage?: boolean | undefined;
  providerMetadata?: boolean | undefined;
  embedding?: boolean | undefined;
  reranking?: boolean | undefined;
  runtimeContext?: boolean | undefined;
  headers?: boolean | undefined;
  toolChoice?: boolean | undefined;
  schema?: boolean | undefined;
}

export declare class OpenTelemetry implements Telemetry {
  constructor(options?: OpenTelemetryOptions);
  executeTool: NonNullable<Telemetry["executeTool"]>;
  onStart: NonNullable<Telemetry["onStart"]>;
  onStepStart: NonNullable<Telemetry["onStepStart"]>;
  onLanguageModelCallStart: NonNullable<Telemetry["onLanguageModelCallStart"]>;
  onLanguageModelCallEnd: NonNullable<Telemetry["onLanguageModelCallEnd"]>;
  onToolExecutionStart: NonNullable<Telemetry["onToolExecutionStart"]>;
  onToolExecutionEnd: NonNullable<Telemetry["onToolExecutionEnd"]>;
  onStepFinish: NonNullable<Telemetry["onStepFinish"]>;
  onFinish: NonNullable<Telemetry["onFinish"]>;
  onEmbedStart: NonNullable<Telemetry["onEmbedStart"]>;
  onEmbedFinish: NonNullable<Telemetry["onEmbedFinish"]>;
  onRerankStart: NonNullable<Telemetry["onRerankStart"]>;
  onRerankFinish: NonNullable<Telemetry["onRerankFinish"]>;
  onChunk: NonNullable<Telemetry["onChunk"]>;
  onError: NonNullable<Telemetry["onError"]>;
}

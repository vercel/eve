import { otelIntegration } from "eve/instrumentation/otel";
import { traceAuditProcessor } from "../lib/trace-audit";

export default otelIntegration({ spanProcessors: [traceAuditProcessor] });

import { otel } from "eve/instrumentation/otel";

// The Postgres suite runs a production Node server without automatic tracing.
// Enable OTel so the local fan-out eval can check trace identity.
export default otel({});

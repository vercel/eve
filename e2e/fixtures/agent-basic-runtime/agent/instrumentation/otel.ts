import { otel } from "eve/instrumentation/otel";

export default otel({ instrumentations: ["fetch"] });

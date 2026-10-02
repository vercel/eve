import webFetchDefinition from "#tools/provided/web-fetch.js";

export {
  WEB_FETCH_INPUT_SCHEMA,
  WEB_FETCH_OUTPUT_SCHEMA,
  type WebFetchToolInput,
  type WebFetchToolOutput,
  webFetch,
} from "#tools/provided/web-fetch.js";

export default webFetchDefinition;

export {
  type WebFetchProvider,
  type WebFetchProviderInput,
  type WebFetchProviderDefinition,
  webFetchProvider,
} from "#tools/provided/web-fetch-provider.js";

// Public entry of `@eve/takeover/core`: the shared runtime that the takeover
// extension (the viewer) and screen extensions (the tools) both use.
export {
  closeTakeover,
  DEFAULT_TAKEOVER_PORT,
  DEFAULT_TAKEOVER_TTL_MS,
  defineTakeover,
  openTakeover,
  TAKEOVER_ROUTE_PREFIX,
  toStreamUrl,
  type OpenTakeoverInput,
  type OpenTakeoverResult,
  type Takeover,
  type TakeoverOptions,
  type TakeoverSandbox,
  type TakeoverSource,
  type TakeoverViewer,
} from "./takeover.ts";
export {
  vercelSandboxPorts,
  type LookupVercelSandbox,
  type PortExposer,
  type VercelPortSandbox,
} from "./expose.ts";
export {
  deriveTakeoverKeys,
  mintStreamToken,
  openTakeoverGrant,
  sealTakeoverGrant,
  STREAM_TOKEN_MAX_TTL_MS,
  verifyStreamToken,
  type TakeoverGrant,
  type TakeoverProtocol,
  type TakeoverRequester,
} from "./keys.ts";
export { PAGE_STREAM_TOKEN_TTL_MS, sameRequester, viewerPage, viewerToken } from "./viewer.ts";
export {
  runTakeoverTool,
  TAKEOVER_DONE_PARAM,
  takeoverInputSchema,
  takeoverToolDescription,
  type TakeoverToolContext,
  type TakeoverToolOutput,
} from "./tool.ts";
export { TAKEOVER_PROXY_SOURCE } from "./proxy-source.ts";

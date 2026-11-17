import { defineChannel, GET, POST } from "eve/channels";

import extension from "../extension.ts";
import { TAKEOVER_ROUTE_PREFIX } from "../lib/takeover.ts";
import { viewerPage, viewerToken } from "../lib/viewer.ts";

// The page the takeover link opens, and the stream token it asks for. Every route
// signs the viewer in with the configured auth and admits only the requester.
export default defineChannel({
  routes: [
    GET(`${TAKEOVER_ROUTE_PREFIX}/:grant`, (request, { params }) =>
      viewerPage(extension.config.takeover, request, params.grant),
    ),
    POST(`${TAKEOVER_ROUTE_PREFIX}/:grant/token`, (request, { params }) =>
      viewerToken(extension.config.takeover, request, params.grant),
    ),
  ],
});

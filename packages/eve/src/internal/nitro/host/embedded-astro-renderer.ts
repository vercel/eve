import astroApplication from "./embedded-astro-application.js";

interface NitroRendererEvent {
  readonly req: Request;
}

export default function renderEmbeddedAstro(
  event: NitroRendererEvent,
): Promise<Response> | Response {
  return astroApplication.fetch(event.req);
}

import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";

export function proxyStreamResponse(upstream: Response): Response {
  const allowed = [
    "x-accel-buffering",
    EVE_SESSION_ID_HEADER,
    EVE_STREAM_FORMAT_HEADER,
    EVE_STREAM_TAIL_INDEX_HEADER,
    EVE_STREAM_VERSION_HEADER,
  ];
  const headers = new Headers([...upstream.headers].filter(([name]) => allowed.includes(name)));
  const contentType = upstream.ok ? EVE_MESSAGE_STREAM_CONTENT_TYPE : "application/json";
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  const receivedType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (receivedType !== contentType.split(";")[0] || (!upstream.ok && upstream.status < 400)) {
    void upstream.body?.cancel().catch(() => {});
    headers.set("content-type", "application/json");
    return Response.json(
      {
        ok: false,
        code: "invalid_stream_response",
        error: "Remote session stream returned an unexpected response type.",
      },
      { status: upstream.status >= 400 ? upstream.status : 502, headers },
    );
  }
  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

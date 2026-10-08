import {
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

export function proxyStreamHeaders(headers: Headers): Headers {
  const allowed = [
    "cache-control",
    "content-type",
    "x-accel-buffering",
    EVE_SESSION_ID_HEADER,
    EVE_STREAM_FORMAT_HEADER,
    EVE_STREAM_TAIL_INDEX_HEADER,
    EVE_STREAM_VERSION_HEADER,
  ];
  return new Headers([...headers].filter(([name]) => allowed.includes(name)));
}

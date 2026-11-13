export function browserPreview(events: readonly unknown[]) {
  let screenshot: string | undefined;
  let url: string | undefined;
  let httpStatus: number | undefined;
  for (const value of events) {
    if (!value || typeof value !== "object") continue;
    const event = value as {
      type?: string;
      data?: {
        result?: { kind?: string; toolName?: string; isError?: boolean; output?: unknown };
      };
    };
    const result = event.data?.result;
    if (
      event.type !== "action.result" ||
      result?.kind !== "tool-result" ||
      result.isError ||
      !result.output ||
      typeof result.output !== "object"
    )
      continue;
    const envelope = result.output as {
      result?: Record<string, unknown>;
      workbench?: { screenshotDataUrl?: string; browser?: { url?: string } };
    };
    const output = envelope.result ?? (result.output as Record<string, unknown>);
    const workbench = envelope.workbench;
    const nextUrl = typeof output.url === "string" ? output.url : workbench?.browser?.url;
    if (result.toolName === "run" || (typeof nextUrl === "string" && nextUrl !== url)) {
      // Ordinary browser work can navigate without reporting an HTTP status.
      httpStatus = undefined;
      screenshot = undefined;
    }
    if (typeof nextUrl === "string") url = nextUrl;
    if (typeof output.httpStatus === "number") {
      httpStatus = output.httpStatus;
      screenshot = undefined;
    }
    if (
      typeof output.screenshot === "string" &&
      output.screenshot.startsWith("data:image/png;base64,")
    )
      screenshot = output.screenshot;
    if (workbench?.screenshotDataUrl?.startsWith("data:image/png;base64,"))
      screenshot = workbench.screenshotDataUrl;
    if (output.closed === true) {
      screenshot = undefined;
      url = undefined;
      httpStatus = undefined;
    }
  }
  return { screenshot, url, httpStatus };
}

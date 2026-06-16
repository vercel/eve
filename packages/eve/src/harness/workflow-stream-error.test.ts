import { describe, expect, it } from "vitest";

import {
  extractWorkflowStreamWriteErrorDetails,
  isWorkflowStreamWriteError,
} from "#harness/workflow-stream-error.js";

describe("extractWorkflowStreamWriteErrorDetails", () => {
  it("parses status, url, and vercel headers from the timeout signature", () => {
    const error = new Error(
      "Stream write failed: HTTP 504 (PUT https://vercel-workflow.com/api/v2/runs/wrun_x/stream/strm_x_user; " +
        "x-vercel-id=iad1:iad1::jgpkw-1780499981373-7a2add4f423f; " +
        "x-vercel-error=FUNCTION_INVOCATION_TIMEOUT): An error occurred with your deployment",
    );
    expect(extractWorkflowStreamWriteErrorDetails(error)).toEqual({
      operation: "write",
      statusCode: 504,
      url: "https://vercel-workflow.com/api/v2/runs/wrun_x/stream/strm_x_user",
      vercelId: "iad1:iad1::jgpkw-1780499981373-7a2add4f423f",
      vercelError: "FUNCTION_INVOCATION_TIMEOUT",
    });
  });

  it("parses the stream-close variant", () => {
    expect(
      extractWorkflowStreamWriteErrorDetails(
        new Error("Stream close failed: HTTP 500 (PUT https://vercel-workflow.com/x): boom"),
      ),
    ).toEqual({
      operation: "close",
      statusCode: 500,
      url: "https://vercel-workflow.com/x",
    });
  });

  it("parses through a wrapped cause chain", () => {
    const cause = new Error(
      "Stream write failed: HTTP 502 (PUT https://vercel-workflow.com/y): bad",
    );
    const wrapper = new Error("emit failed", { cause });
    expect(extractWorkflowStreamWriteErrorDetails(wrapper)?.statusCode).toBe(502);
  });

  it("returns operation only when no request context is present", () => {
    expect(
      extractWorkflowStreamWriteErrorDetails(new Error("Stream write failed: HTTP 503")),
    ).toEqual({ operation: "write", statusCode: 503 });
  });

  it("returns null for genuine model-call errors", () => {
    expect(extractWorkflowStreamWriteErrorDetails(new Error("model overloaded"))).toBeNull();
    const gatewayLike = Object.assign(new Error("AI Gateway rejected the model request"), {
      statusCode: 504,
    });
    expect(extractWorkflowStreamWriteErrorDetails(gatewayLike)).toBeNull();
  });

  it("returns null for stream read/fetch failures", () => {
    expect(
      extractWorkflowStreamWriteErrorDetails(new Error("Failed to fetch stream: 504")),
    ).toBeNull();
  });

  it("returns null for non-error inputs", () => {
    expect(extractWorkflowStreamWriteErrorDetails(undefined)).toBeNull();
    expect(extractWorkflowStreamWriteErrorDetails(null)).toBeNull();
    expect(extractWorkflowStreamWriteErrorDetails("Stream write failed: HTTP 504")).toBeNull();
    expect(extractWorkflowStreamWriteErrorDetails(504)).toBeNull();
  });
});

describe("isWorkflowStreamWriteError", () => {
  it("is true for a workflow stream-write failure", () => {
    expect(
      isWorkflowStreamWriteError(new Error("Stream write failed: HTTP 504 (PUT https://x): t")),
    ).toBe(true);
  });

  it("is false for a model-call error", () => {
    expect(isWorkflowStreamWriteError(new Error("model overloaded"))).toBe(false);
  });
});

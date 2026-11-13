import { describe, expect, it } from "vitest";
import { browserPreview } from "../app/projection";

const event = (output: unknown, isError = false) => ({
  type: "action.result",
  data: { result: { kind: "tool-result", output, isError } },
});
describe("shared browser output in the Bell panel", () => {
  it("reads the browser runtime's nested screenshot", () => {
    expect(
      browserPreview([
        event({
          result: {},
          workbench: {
            browser: { url: "https://example.com/" },
            screenshotDataUrl: "data:image/png;base64,aA==",
          },
        }),
      ]),
    ).toEqual({
      url: "https://example.com/",
      screenshot: "data:image/png;base64,aA==",
      httpStatus: undefined,
    });
  });
  it("clears the old capture after a new merchant navigation", () => {
    expect(
      browserPreview([
        event({
          workbench: { screenshotDataUrl: "data:image/png;base64,aA==" },
        }),
        event({
          result: { url: "https://example.com/protected", httpStatus: 401 },
        }),
      ]).screenshot,
    ).toBeUndefined();
  });
  it("ignores failed tools and remote image URLs", () => {
    expect(
      browserPreview([
        event({ screenshot: "https://example.com/tracker" }),
        event({ httpStatus: 200 }, true),
      ]),
    ).toEqual({ url: undefined, screenshot: undefined, httpStatus: undefined });
  });
  it("does not show a previous HTTP 200 after an ordinary browser visit", () => {
    const ordinary = event({ result: { completed: true, url: "https://example.com/protected" } });
    expect(
      browserPreview([
        event({ httpStatus: 200, screenshot: "data:image/png;base64,aA==" }),
        { ...ordinary, data: { result: { ...ordinary.data.result, toolName: "run" } } },
      ]),
    ).toEqual({
      url: "https://example.com/protected",
      screenshot: undefined,
      httpStatus: undefined,
    });
  });
  it("clears the previous page's capture and status after a login redirects", () => {
    expect(browserPreview([
      event({ url: "https://shop.example/login", httpStatus: 200, screenshot: "data:image/png;base64,aA==" }),
      event({
        result: { status: "complete" },
        workbench: { browser: { url: "https://shop.example/account" } },
      }),
    ])).toEqual({
      url: "https://shop.example/account",
      screenshot: undefined,
      httpStatus: undefined,
    });
  });
  it("keeps a new page's own capture and status when its URL changes", () => {
    expect(browserPreview([
      event({ url: "https://shop.example/login", httpStatus: 200, screenshot: "data:image/png;base64,aA==" }),
      event({ url: "https://shop.example/account", httpStatus: 403, screenshot: "data:image/png;base64,bA==" }),
    ])).toEqual({
      url: "https://shop.example/account",
      screenshot: "data:image/png;base64,bA==",
      httpStatus: 403,
    });
  });
});

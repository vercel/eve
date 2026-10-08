import { describe, expect, it } from "vitest";

import { unavailableToolMessage } from "#harness/input-request-resolution.js";

describe("unavailableToolMessage", () => {
  it("points at eve__search only for an agent that has it", () => {
    expect(unavailableToolMessage("deploy", true)).toBe(
      'The tool "deploy" is no longer available, so the call didn\'t run. If the task still needs it, find an available tool with eve__search and make a new call.',
    );
    expect(unavailableToolMessage("deploy", false)).toBe(
      'The tool "deploy" is no longer available, so the call didn\'t run. If the task still needs it, make a new call with an available tool.',
    );
  });
});

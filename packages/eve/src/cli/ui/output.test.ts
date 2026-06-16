import { describe, expect, it } from "vitest";

import {
  createCliTheme,
  renderCliBanner,
  renderCliSection,
  renderCliSpeakerLine,
  renderCliTaggedLine,
  sanitizeForTerminal,
} from "./output.js";

const osc52 = "\x1b]52;c;cGFzdGU=\x07";
const oscTitle = "\x1b]0;spoofed\x07";
const osc8Start = "\x1b]8;;https://attacker.example\x07";
const osc8End = "\x1b]8;;\x07";
const dcs = "\x1bPqpayload\x1b\\";
const c1Osc = "\u009d0;c1-title\u009c";

describe("sanitizeForTerminal", () => {
  it("removes control characters while preserving tabs and newlines", () => {
    const input = "a\tb\nc\rd\x00e\x08f\x0bg\x7fh\u0085i";

    expect(sanitizeForTerminal(input)).toBe("a\tb\ncdefghi");
  });

  it("removes ANSI, OSC, DCS, and C1 terminal controls", () => {
    const input = [
      `safe ${osc52}copy`,
      `${osc8Start}linked${osc8End}`,
      dcs,
      c1Osc,
      "\x1b[31mred\x1b[0m",
      "\x1b[2Jclear",
      "\x1b(Bcharset",
    ].join(" ");

    const sanitized = sanitizeForTerminal(input);

    expect(sanitized).toContain("safe copy");
    expect(sanitized).toContain("linked");
    expect(sanitized).toContain("red");
    expect(sanitized).toContain("clear");
    expect(sanitized).toContain("charset");
    expect(sanitized).not.toContain("cGFzdGU");
    expect(sanitized).not.toContain("attacker");
    expect(sanitized).not.toContain("payload");
    expect(sanitized).not.toContain("title");
    expectTerminalSafe(sanitized);
  });
});

describe("CLI renderers", () => {
  it("sanitize tagged-line messages and tags before rendering", () => {
    const theme = createCliTheme({ color: false });

    expect(
      renderCliTaggedLine(theme, {
        message: `before${osc52}after \x1b[31mred\x1b[0m`,
        tag: `event${oscTitle}`,
      }),
    ).toBe("[EVENT] beforeafter red");
  });

  it("sanitize speaker-line messages and speakers before rendering", () => {
    const theme = createCliTheme({ color: false });

    expect(
      renderCliSpeakerLine(theme, {
        message: `${osc8Start}linked${osc8End}`,
        speaker: `agent${c1Osc}`,
      }),
    ).toBe("agent> linked");
  });

  it("sanitize banner and section fields before rendering", () => {
    const theme = createCliTheme({ color: false });

    expect(renderCliBanner(theme, { subtitle: `sub${dcs}title`, title: `ev${oscTitle}e` })).toBe(
      "eve\n===\nsubtitle",
    );
    expect(
      renderCliSection(theme, {
        rows: [{ label: `Na${oscTitle}me`, value: `Val${osc52}ue` }],
        title: `Sec${c1Osc}tion`,
      }),
    ).toBe("Section\nName  Value");
  });
});

function expectTerminalSafe(value: string): void {
  for (const sequence of ["\x1b", "\u009b", "\u009d", "\u009c", "\x07", "\r", "\x00", "\x7f"]) {
    expect(value).not.toContain(sequence);
  }
}

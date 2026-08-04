import { describe, expect, it } from "vitest";
import { isSupportedLanguage, supportedLanguages } from "./languages";

describe("supported languages", () => {
  it("accepts configured locales", () => {
    expect(supportedLanguages).toEqual(["en"]);
    expect(isSupportedLanguage("en")).toBe(true);
  });

  it.each(["api", "apple-touch-icon.png", "llms-full.txt", "unknown.xml"])(
    "rejects root segment %s as a locale",
    (language) => {
      expect(isSupportedLanguage(language)).toBe(false);
    },
  );
});

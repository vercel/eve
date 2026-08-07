import { describe, expect, it } from "vitest";
import { defaultLanguage, isSupportedLanguage, supportedLanguages } from "./languages";

describe("supported languages", () => {
  it("accepts configured locales", () => {
    expect(defaultLanguage).toBe("en");
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

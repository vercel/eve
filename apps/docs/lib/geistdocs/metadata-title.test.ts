import { describe, expect, it } from "vitest";
import {
  formatPageTitle,
  metadataTitle,
  pageTitleMetadata,
  rootTitleMetadata,
  siteTitle,
} from "./metadata-title";

describe("metadata titles", () => {
  it("defines normal child title inheritance at the shared layout", () => {
    expect(rootTitleMetadata).toEqual({
      default: "eve – durable AI agent framework",
      template: "%s – eve",
    });
    expect(metadataTitle("Integrations")).toBe("Integrations");
    expect(formatPageTitle("Integrations")).toBe("Integrations – eve");
  });

  it("keeps the homepage title absolute", () => {
    expect(metadataTitle(siteTitle)).toEqual({ absolute: siteTitle });
    expect(pageTitleMetadata(siteTitle)).toEqual({
      title: { absolute: siteTitle },
      openGraph: { title: siteTitle },
      twitter: { title: siteTitle },
    });
  });

  it.each(["Self-host eve", "Get started with eve: durable AI agents in TypeScript"])(
    "does not suffix explicit standalone branding in %s",
    (title) => {
      expect(metadataTitle(title)).toEqual({ absolute: title });
      expect(formatPageTitle(title)).toBe(title);
    },
  );

  it("does not treat useEveAgent as standalone branding", () => {
    const title = "Build an AI agent chat UI with useEveAgent";
    expect(metadataTitle(title)).toBe(title);
    expect(formatPageTitle(title)).toBe(`${title} – eve`);
  });

  it("applies the shared suffix to template titles", () => {
    expect(formatPageTitle("Chat template")).toBe("Chat template – eve");
  });
});

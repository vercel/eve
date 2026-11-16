import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computed, createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import type { EveMessage } from "eve/vue";
import MessageContent from "../apps/web/app/components/chat/message/MessageContentEve.vue";
import { toUIMessages } from "../apps/web/app/composables/chat/providers/eve/adapter";

beforeEach(() => vi.stubGlobal("computed", computed));
afterEach(() => vi.unstubAllGlobals());

async function render(parts: EveMessage["parts"]) {
  const message = toUIMessages([{ id: "message", role: "assistant", parts }])[0]!;
  const app = createSSRApp(MessageContent, { message, status: "ready" });
  app.component("UIcon", defineComponent({ render: () => h("i") }));
  app.component(
    "UChatTool",
    defineComponent({
      props: ["text"],
      setup:
        (props, { slots }) =>
        () =>
          h("section", [props.text, slots.default?.()]),
    }),
  );
  app.component("ChatToolSources", defineComponent({ render: () => h("div", "Sources") }));
  app.config.globalProperties.getSearchQuery = () => "Vercel";
  app.config.globalProperties.getSources = () => [];
  return renderToString(app);
}

it("previews web images and links files, while keeping inline or unsafe attachments as text", async () => {
  const html = await render([
    {
      type: "file",
      mediaType: "image/png",
      filename: "chart.png",
      url: "https://example.com/chart.png",
    },
    {
      type: "file",
      mediaType: "application/pdf",
      filename: "report.pdf",
      url: "http://example.com/report.pdf",
    },
    { type: "file", mediaType: "image/png", filename: "inline.png" },
    {
      type: "file",
      mediaType: "image/svg+xml",
      filename: "unsafe.svg",
      url: "javascript:alert(1)",
    },
    {
      type: "file",
      mediaType: "image/png",
      filename: "data.png",
      url: "data:image/png;base64,AAAA",
    },
    { type: "file", mediaType: "text/plain", filename: "relative.txt", url: "//example.com/file" },
  ] as EveMessage["parts"]);
  expect(html).toContain('src="https://example.com/chart.png"');
  expect(html).toContain('href="http://example.com/report.pdf"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("inline.png");
  expect(html).toContain("unsafe.svg");
  expect(html).toContain("data.png");
  expect(html).toContain("relative.txt");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("data:image");
  expect(html).not.toContain('src="//');
  expect(html.match(/<img /g)).toHaveLength(1);
});

it("renders a web-search failure instead of a successful sources panel", async () => {
  const html = await render([
    {
      type: "tool",
      callId: "search",
      name: "web_search",
      state: "failed",
      input: { query: "Vercel" },
      error: { message: "Search unavailable" },
      kind: "tool",
      stepIndex: 0,
    },
  ]);
  expect(html).toContain("Web search failed");
  expect(html).toContain("Search unavailable");
  expect(html).not.toContain("Sources");
  expect(html).not.toContain("Searched the web");
});

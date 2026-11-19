import { z } from "zod";
import { getKernel } from "@/agent/subagents/browser-agent/lib/kernel";
import { maximumBrowserImageBytes } from "@/lib/browser/artifact";
import {
  renderPublicResearchPreview,
  type readPublicResearchPage,
} from "@/lib/browser/public-preview";

const screenshotSchema = z.object({
  verified: z.literal(true),
  png: z.base64().max(Math.ceil(maximumBrowserImageBytes / 3) * 4),
});

export async function capturePublicResearchPreview(
  researchPage: Awaited<ReturnType<typeof readPublicResearchPage>>,
  signal: AbortSignal,
) {
  const kernel = getKernel();
  const session = await kernel.browsers.create(
    { timeout_seconds: 60 },
    { signal, timeout: 15_000, maxRetries: 0 },
  );
  try {
    // The screenshot runs only on an app-generated, form-free document. The
    // browser never navigates to a merchant or receives a signed-in profile.
    const result = await kernel.browsers.playwright.execute(
      session.session_id,
      {
        code: `
const context = await browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: "block", viewport: { width: 1024, height: 768 } });
try {
  await context.route("**/*", route => route.abort());
  const preview = await context.newPage();
  await preview.setContent(${JSON.stringify(renderPublicResearchPreview(researchPage))}, { waitUntil: "load", timeout: 5000 });
  const verify = async () => {
    if (preview.url() !== "about:blank" || preview.frames().length !== 1 ||
        await preview.locator("#public-research-preview").count() !== 1 ||
        await preview.locator("input, textarea, form, select, button, iframe, frame, object, embed, [contenteditable]").count() !== 0) {
      throw new Error("The research preview is not safe to capture.");
    }
  };
  await verify();
  const png = await preview.screenshot({ type: "png", animations: "disabled", timeout: 5000 });
  await verify();
  return { verified: true, png: png.toString("base64") };
} finally {
  await context.close();
}`,
        timeout_sec: 15,
      },
      { signal, timeout: 20_000, maxRetries: 0 },
    );
    const capture = screenshotSchema.safeParse(result.success ? result.result : undefined);
    if (!capture.success) throw new Error("Could not verify a safe browser screenshot.");
    const bytes = Buffer.from(capture.data.png, "base64");
    if (bytes.length > maximumBrowserImageBytes) throw new Error("Browser preview is too large.");
    return bytes;
  } finally {
    await kernel.browsers
      .deleteByID(session.session_id, { timeout: 5_000, maxRetries: 0 })
      .catch(() => undefined);
  }
}

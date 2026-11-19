import { getKernel } from "@/agent/subagents/browser-agent/lib/kernel";

// Screenshots reach the model and can be sent to the user, so sensitive form
// values are hidden while one is captured: passwords, payment card fields,
// and one-time codes, whoever typed them.
const sensitiveFieldSelector = [
  'input[type="password"]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
].join(", ");

export async function withSensitiveFieldMask<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  capture: () => Promise<T>,
) {
  await setSensitiveFieldMask(sessionId, "add", signal);
  try {
    return await capture();
  } finally {
    await setSensitiveFieldMask(sessionId, "remove", undefined).catch(() => undefined);
  }
}

async function setSensitiveFieldMask(
  sessionId: string,
  action: "add" | "remove",
  signal?: AbortSignal,
) {
  const styleId = "sensitive-field-mask";
  // Overlapping captures share one style element, counted by reference.
  const operation =
    action === "add"
      ? `
        const existing = document.getElementById(styleId);
        if (existing) {
          const refs = Number.parseInt(existing.dataset.maskRefs || "0", 10);
          existing.dataset.maskRefs = String((Number.isFinite(refs) ? refs : 0) + 1);
          return;
        }
        const style = document.createElement("style");
        style.id = styleId;
        style.dataset.maskRefs = "1";
        style.textContent = selector + " { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }";
        document.documentElement.append(style);`
      : `
        const style = document.getElementById(styleId);
        if (!style) return;
        const refs = Number.parseInt(style.dataset.maskRefs || "1", 10);
        const remainingRefs = Math.max(0, (Number.isFinite(refs) ? refs : 1) - 1);
        if (remainingRefs > 0) {
          style.dataset.maskRefs = String(remainingRefs);
        } else {
          style.remove();
        }`;
  const code = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate(({ styleId, selector }) => {
        ${operation}
      }, ${JSON.stringify({ selector: sensitiveFieldSelector, styleId })}).catch(() => undefined);
    }
  }
}
return true;`;
  const result = await getKernel().browsers.playwright.execute(
    sessionId,
    { code, timeout_sec: 10 },
    { signal },
  );
  if (!result.success) {
    throw new Error(
      action === "add"
        ? "Sensitive fields could not be masked for screenshot capture."
        : "Sensitive field masking could not be removed.",
    );
  }
}

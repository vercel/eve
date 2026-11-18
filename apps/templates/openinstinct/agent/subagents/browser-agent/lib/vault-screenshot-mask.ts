import { kernel } from "@agent/subagents/browser-agent/lib/kernel";

export async function withVaultScreenshotMask<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  capture: () => Promise<T>
) {
  await setVaultScreenshotMask(sessionId, "add", signal);
  try {
    return await capture();
  } finally {
    await setVaultScreenshotMask(sessionId, "remove", undefined).catch(
      () => undefined
    );
  }
}

async function setVaultScreenshotMask(
  sessionId: string,
  action: "add" | "remove",
  signal?: AbortSignal
) {
  const styleId = "vault-screenshot-mask";
  const selector = '[data-vault-secret="true"]';
  const operation =
    action === "add"
      ? `
        const existing = document.getElementById(styleId);
        if (existing) {
          const refs = Number.parseInt(existing.dataset.vaultMaskRefs || "0", 10);
          existing.dataset.vaultMaskRefs = String((Number.isFinite(refs) ? refs : 0) + 1);
          return;
        }
        const style = document.createElement("style");
        style.id = styleId;
        style.dataset.vaultMaskRefs = "1";
        style.textContent = selector + " { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }";
        document.documentElement.append(style);`
      : `
        const style = document.getElementById(styleId);
        if (!style) return;
        const refs = Number.parseInt(style.dataset.vaultMaskRefs || "1", 10);
        const remainingRefs = Math.max(0, (Number.isFinite(refs) ? refs : 1) - 1);
        if (remainingRefs > 0) {
          style.dataset.vaultMaskRefs = String(remainingRefs);
        } else {
          style.remove();
        }`;
  const code = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate(({ styleId, selector }) => {
        ${operation}
      }, ${JSON.stringify({ selector, styleId })}).catch(() => undefined);
    }
  }
}
return true;`;
  const result = await kernel.browsers.playwright.execute(
    sessionId,
    { code, timeout_sec: 10 },
    { signal }
  );
  if (!result.success) {
    throw new Error(
      action === "add"
        ? "Vault fields could not be masked for screenshot capture."
        : "Vault screenshot masking could not be removed."
    );
  }
}

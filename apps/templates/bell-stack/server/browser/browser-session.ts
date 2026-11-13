import { personalBrowserEnabled, requireReusableContexts } from "../onepassword/browser-policy";
import Browserbase from "@browserbasehq/sdk";
import {
  localBrowser,
  Stagehand,
  browserbase as stagehandBrowserbase,
  type CDPSubscription,
  type CookieParam,
  type StagehandBrowser,
  type Page,
} from "@browserbasehq/stagehand";

import { parseBrowserbaseCaptchaEvent, safeCaptchaPage, type CaptchaSignal } from "../../lib/browser/captcha";
import { addTrace } from "./trace.js";
import type { BrowserProxyLocation, BrowserState, ConversationState, RunAction } from "./types.js";

export interface BrowserCaptchaTransition {
  id: string;
  type: "started" | "finished" | "errored" | "timed_out";
  at: string;
  page?: { origin: string; path: string };
}
export class CaptchaHandoffError extends Error {
  readonly code = "captcha_handoff";
  constructor(readonly reason: "errored" | "timed_out") {
    super(
      reason === "errored"
        ? "CAPTCHA solving errored. Continue in Live View, then resume this task."
        : "CAPTCHA solving timed out. Continue in Live View, then resume this task.",
    );
  }
}

export interface BrowserRecoveryReport {
  visitedOrigins: string[];
  blockedOrigins: string[];
  liveSourceOrigins: string[];
}

const DISCOVERY_HOSTS = ["google.", "bing.com", "duckduckgo.com", "search.brave.com", "yahoo.com"];

export class BrowserSession {
  private stagehand?: Stagehand;
  private browser?: StagehandBrowser;
  private browserbase?: Browserbase;
  private remoteSessionId?: string;
  private startPromise?: Promise<void>;
  private closeRequested = false;
  private operationTail: Promise<void> = Promise.resolve();
  private xpathMap: Record<string, string> = {};
  private readonly visitedOrigins = new Set<string>();
  private readonly blockedOrigins = new Set<string>();
  private readonly liveSourceOrigins = new Set<string>();
  private readonly captchaSubscriptions = new Map<string, CDPSubscription>();
  private readonly captchaTransitions: BrowserCaptchaTransition[] = [];
  private captchaStatus: "idle" | "solving" | "solved" | "errored" | "timed_out" = "idle";
  private captchaStartedAt?: string;
  private captchaNeedsObservation = false;

  constructor(
    private readonly state: ConversationState,
    private readonly options: {
      contextId?: string;
      proxyLocation?: BrowserProxyLocation;
      ensureContext?: (
        currentContextId?: string,
      ) => Promise<{ id: string; status: "draft" | "saved" }>;
      captcha?: { status: "idle" | "solving" | "solved" | "errored" | "timed_out"; startedAt?: string };
    } = {},
  ) {
    this.captchaStatus = options.captcha?.status ?? "idle";
    this.captchaStartedAt = options.captcha?.startedAt;
  }

  resumeAfterHumanInput(): void {
    if (this.captchaStatus !== "errored" && this.captchaStatus !== "timed_out") return;
    this.captchaStatus = "idle";
    this.captchaNeedsObservation = true;
  }

  async start(): Promise<void> {
    if (this.closeRequested)
      throw new DOMException("The browser session was closed.", "AbortError");
    if (this.stagehand && this.browser && !this.browser.closed) return;
    const startPromise = this.startPromise ?? this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
      if (this.closeRequested)
        throw new DOMException("The browser session was closed.", "AbortError");
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    this.state.browser.status = "starting";
    const started = performance.now();
    const requested = browserProvider();
    let contextStatus: "draft" | "saved" | undefined;

    try {
      if (requested === "browserbase") {
        const apiKey = process.env.BROWSERBASE_API_KEY;
        if (!apiKey) throw new Error("BROWSERBASE_API_KEY is required for Browserbase mode.");
        if (personalBrowserEnabled() && (this.options.contextId || process.env.BROWSERBASE_CONTEXT_ID))
          throw new Error("Start a new conversation without a reusable Context for personal 1Password.");
        const currentContextId = this.options.contextId ?? process.env.BROWSERBASE_CONTEXT_ID;
        if (this.options.ensureContext && !personalBrowserEnabled()) {
          const context = await this.options.ensureContext(currentContextId);
          this.options.contextId = context.id;
          contextStatus = context.status;
        } else if (currentContextId) {
          this.options.contextId = currentContextId;
          contextStatus = "saved";
        }
        await this.startBrowserbase(apiKey);
      } else {
        this.browser = await localBrowser.launch({
          headless: process.env.BELL_HEADLESS !== "false",
          viewport: { width: 1360, height: 900 },
        });
        await this.attachStagehand(this.browser);
      }

      this.state.browser = {
        provider: requested,
        status: "active",
        proxies: requested === "browserbase",
        verified: requested === "browserbase",
        contextId: this.options.contextId ?? process.env.BROWSERBASE_CONTEXT_ID,
        contextStatus,
        proxyLocation: requested === "browserbase" ? this.options.proxyLocation : undefined,
        sessionId: this.remoteSessionId,
      };
      await this.ensureCaptchaSubscriptions();
      if (requested === "browserbase" && contextStatus) {
        addTrace(
          this.state,
          "context",
          contextStatus === "draft" ? "context.draft.attach" : "context.attach",
          contextStatus === "draft"
            ? "Attached a draft Context. Browser state is now captured for a later save."
            : "Attached the saved Browserbase Context.",
          { status: contextStatus, persist: true },
        );
      }
      addTrace(
        this.state,
        "browser",
        "browser.start",
        `Started one persistent ${requested} browser for this conversation.`,
        {
          provider: requested,
          reusedByEveryTool: true,
          proxies: requested === "browserbase",
          verified: requested === "browserbase",
          contextStatus,
          proxyLocation: this.options.proxyLocation,
          transport: "Stagehand v4 native Eve tools",
        },
        Math.round(performance.now() - started),
      );
    } catch (error) {
      this.state.browser.status = "error";
      addTrace(this.state, "error", "browser.start", errorMessage(error));
      throw error;
    }
  }

  /** Run a server-owned integration in the existing hosted browser under its operation lock.
   * Never return the connection URL or private request headers from the callback.
   */
  async withHostedPage<T>(
    signal: AbortSignal,
    operation: (page: Page, connectUrl: string, sessionId: string) => Promise<T>,
    privateResult = false,
  ): Promise<T> {
    signal.throwIfAborted();
    const release = await this.acquireOperation();
    try {
      signal.throwIfAborted();
      await this.start();
      await this.gateCaptcha();
      if (!this.browserbase || !this.remoteSessionId || !this.browser)
        throw new Error("This integration requires a hosted Browserbase session.");
      const page =
        (await this.browser.context.activePage()) ?? (await this.browser.context.newPage());
      const session = await this.browserbase.sessions.retrieve(this.remoteSessionId);
      if (!session.connectUrl) throw new Error("The hosted browser connection is unavailable.");
      const result = await operation(page, session.connectUrl, this.remoteSessionId);
      this.xpathMap = {};
      if (!privateResult) {
        this.updateBrowserState(await page.url(), await page.title());
        await this.gateCaptcha();
      }
      return result;
    } finally {
      release();
    }
  }

  async snapshot(): Promise<{
    tree: string;
    url: string;
    snapshotIdCount: number;
    pageStatus: "live" | "blocked";
    recovery: BrowserRecoveryReport;
  }> {
    const release = await this.acquireOperation();
    try {
      await this.start();
      await this.gateCaptcha();
      const started = performance.now();
      const result = await this.requireStagehand().experimentalBatch(async ({ page }) => {
        const snapshot = await page.snapshot({ includeIframes: true });
        return {
          snapshot,
          url: await page.url(),
          title: await page.title(),
        };
      });
      await this.gateCaptcha();
      this.xpathMap = result.snapshot.xpathMap;
      const url = result.url;
      this.updateBrowserState(result.url, result.title);
      const assessment = assessSnapshot(result.snapshot.formattedTree, url);
      const origin = originOf(url);
      if (origin) this.visitedOrigins.add(origin);
      if (assessment.blocked && origin) {
        const firstBlockOnOrigin = !this.blockedOrigins.has(origin);
        this.blockedOrigins.add(origin);
        this.liveSourceOrigins.delete(origin);
        if (firstBlockOnOrigin) {
          addTrace(
            this.state,
            "browser",
            "block.detected",
            `Detected an access block on ${origin}. The task must continue on another source.`,
            { origin, signal: assessment.signal },
          );
        }
      } else if (origin && isLiveSourceUrl(url)) {
        this.liveSourceOrigins.add(origin);
      }
      addTrace(
        this.state,
        "tool",
        "snapshot",
        `Read the current accessibility tree and found ${Object.keys(result.snapshot.xpathMap).length} targets.`,
        {
          url,
          pageStatus: assessment.blocked ? "blocked" : "live",
          treePreview: result.snapshot.formattedTree.slice(0, 1200),
        },
        Math.round(performance.now() - started),
      );
      return {
        tree: result.snapshot.formattedTree.slice(0, 14_000),
        url,
        snapshotIdCount: Object.keys(result.snapshot.xpathMap).length,
        pageStatus: assessment.blocked ? "blocked" : "live",
        recovery: this.recoveryReport(),
      };
    } finally {
      release();
    }
  }

  async run(actions: RunAction[]): Promise<{ completed: number; url: string }> {
    for (const item of actions) {
      if (item.action !== "goto") continue;
      const destination = new URL(item.url);
      if (
        !["https:", "http:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials.");
    }
    const release = await this.acquireOperation();
    try {
      await this.start();
      await this.gateCaptcha();
      const started = performance.now();
      const resolvedActions = actions.map((item) =>
        "target" in item && item.target
          ? { ...item, target: this.resolveTarget(item.target) }
          : item,
      );
      const result = await this.requireStagehand().experimentalBatch(
        async ({ page }, batchActions) => {
          for (const item of batchActions) {
            switch (item.action) {
              case "goto":
                await page.goto(item.url);
                await page.waitForLoadState("domcontentloaded", 15_000);
                break;
              case "click":
                await page.locator(item.target).click();
                break;
              case "fill":
                await page.locator(item.target).fill(item.value);
                break;
              case "type":
                await page.locator(item.target).type(item.value);
                break;
              case "press":
                if (item.target) await page.locator(item.target).click();
                await page.keyPress(item.key);
                break;
              case "select":
                await page.locator(item.target).selectOption(item.value);
                break;
              case "wait":
                await page.waitForTimeout(Math.min(item.milliseconds, 10_000));
                break;
            }
          }
          return { url: await page.url(), title: await page.title() };
        },
        resolvedActions,
        { timeout: 60_000 },
      );

      await this.gateCaptcha();
      this.xpathMap = {};
      this.updateBrowserState(result.url, result.title);
      const url = result.url;
      const origin = originOf(url);
      if (origin) this.visitedOrigins.add(origin);
      addTrace(
        this.state,
        "tool",
        "run",
        `Completed ${actions.length} exact browser action${actions.length === 1 ? "" : "s"}.`,
        { actions, url, snapshotIdsInvalidated: true },
        Math.round(performance.now() - started),
        formatRunCode(resolvedActions),
      );
      return { completed: actions.length, url };
    } finally {
      release();
    }
  }

  async secureLogin(input: {
    allowedHosts: string[];
    username: string;
    password: string;
    usernameTarget: string;
    passwordTarget: string;
    submitTarget: string;
    totp?: string;
    totpTarget?: string;
    otpSubmitTarget?: string;
    successTarget?: string;
    totpAfterSubmit?: boolean;
  }): Promise<{
    status: "complete" | "waiting_for_user" | "unverified";
    host: string;
    url: string;
  }> {
    const selectors = [input.usernameTarget, input.passwordTarget, input.submitTarget,
      input.totpTarget, input.otpSubmitTarget, input.successTarget];
    if (selectors.some((selector) => selector && (/^\s*(?:xpath=|\/|\()/i.test(selector) || selector.includes(">>"))))
      throw new Error("Secure login requires CSS selectors in the top-level page; frame selectors are not allowed.");
    const release = await this.acquireOperation();
    try {
      await this.start();
      await this.gateCaptcha();
      const started = performance.now();
      const result = await this.requireStagehand().experimentalBatch(
        async ({ page }, values) => {
          const checkDestination = async () => {
            const destination = new URL(await page.url());
            if (
              destination.protocol !== "https:" ||
              destination.username ||
              destination.password ||
              !values.allowedHosts.includes(destination.hostname.toLowerCase())
            )
              throw new Error("Unsafe credential destination.");
          };
          await checkDestination();
          await page.locator(values.usernameTarget).fill(values.username);
          await checkDestination();
          await page.locator(values.passwordTarget).fill(values.password);
          if (values.totpTarget && values.totp && !values.totpAfterSubmit) {
            await checkDestination();
            await page.locator(values.totpTarget).fill(values.totp);
          }
          await checkDestination();
          await page.locator(values.submitTarget).click();
          await page.waitForTimeout(1_000);
          if (values.totpTarget && values.totp && values.totpAfterSubmit) {
            await checkDestination();
            await page.locator(values.totpTarget).fill(values.totp);
            if (values.otpSubmitTarget) {
              await checkDestination();
              await page.locator(values.otpSubmitTarget).click();
            }
            await page.waitForTimeout(1_000);
          }
          const url = await page.url(),
            title = await page.title();
          const success = values.successTarget
            ? (await page.locator(values.successTarget).count()) > 0
            : false;
          return { url, title, success };
        },
        input,
        { timeout: 45_000 },
      );
      await this.gateCaptcha();
      this.updateBrowserState(result.url, result.title);
      const host = new URL(result.url).hostname;
      const status =
        input.totpTarget && !input.totp
          ? "waiting_for_user"
          : result.success
            ? "complete"
            : "unverified";
      addTrace(
        this.state,
        "tool",
        "vault.login",
        status === "complete"
          ? `Verified login state on ${host}.`
          : status === "waiting_for_user"
            ? `Login on ${host} is waiting for a human challenge.`
            : `Filled the login on ${host}, but success is not verified yet.`,
        { host, status, secretValuesRedacted: true },
        Math.round(performance.now() - started),
      );
      return { status, host, url: result.url };
    } catch (error) {
      if (error instanceof CaptchaHandoffError) throw error;
      addTrace(
        this.state,
        "error",
        "vault.login",
        "The secure login attempt failed. Secret values were redacted.",
      );
      throw new Error(
        "Secure login failed. Inspect the current page and field selectors, then retry.",
      );
    } finally {
      release();
    }
  }

  async screenshot(): Promise<{
    mediaType: "image/png";
    data: string;
    url: string;
  }> {
    const release = await this.acquireOperation();
    try {
      await this.start();
      await this.gateCaptcha();
      const started = performance.now();
      const result = await this.requireStagehand().experimentalBatch(async ({ page }) => ({
        data: await page.screenshot({ type: "png" }),
        url: await page.url(),
        title: await page.title(),
      }));
      await this.gateCaptcha();
      const buffer = toBuffer(result.data);
      this.state.screenshot = buffer;
      this.updateBrowserState(result.url, result.title);
      const url = result.url;
      addTrace(
        this.state,
        "tool",
        "screenshot",
        "Captured the visible browser page.",
        { url, bytes: buffer.byteLength },
        Math.round(performance.now() - started),
      );
      return { mediaType: "image/png", data: buffer.toString("base64"), url };
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    await this.startPromise?.catch(() => undefined);
    await this.clearCaptchaSubscriptions();
    const stagehand = this.stagehand;
    const browser = this.browser;
    this.stagehand = undefined;
    this.browser = undefined;
    await stagehand?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await this.releaseRemoteSession();
    if (this.state.browser.status !== "error") this.state.browser.status = "idle";
  }

  hasStarted(): boolean {
    return Boolean(this.stagehand && this.browser && !this.browser.closed);
  }

  async exportCookies(): Promise<CookieParam[]> {
    requireReusableContexts();
    if (!this.hasStarted()) return [];
    return this.browser!.context.cookies();
  }

  async importCookies(cookies: CookieParam[], url?: string): Promise<void> {
    const release = await this.acquireOperation();
    try {
      await this.start();
      if (cookies.length) await this.browser!.context.addCookies(cookies);
      if (url) {
        const page =
          (await this.browser!.context.activePage()) ?? (await this.browser!.context.newPage());
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        this.updateBrowserState(await page.url(), await page.title());
      }
      addTrace(
        this.state,
        "context",
        "context.capture",
        "Moved the current browser cookies into a reusable Browserbase Context.",
        {
          cookieCount: cookies.length,
          url: url ? safeCaptchaPage(url) : undefined,
        },
      );
    } finally {
      release();
    }
  }

  recoveryReport(): BrowserRecoveryReport {
    return {
      visitedOrigins: [...this.visitedOrigins],
      blockedOrigins: [...this.blockedOrigins],
      liveSourceOrigins: [...this.liveSourceOrigins],
    };
  }

  private resolveTarget(target: string): string {
    const raw = target.replace(/^\[/, "").replace(/\]$/, "");
    const xpath = this.xpathMap[target] ?? this.xpathMap[raw];
    if (!xpath && /^\[?\d+\]?$/.test(target)) {
      throw new Error("This snapshot ID is not in the latest snapshot. Call snapshot again.");
    }
    if (!xpath) return target;
    return xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
  }

  private requireStagehand(): Stagehand {
    if (!this.stagehand) throw new Error("The Stagehand client is not ready.");
    return this.stagehand;
  }

  private async acquireOperation(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.operationTail;
    this.operationTail = previous.then(() => gate);
    await previous;
    if (this.closeRequested) {
      release();
      throw new DOMException("The browser session was closed.", "AbortError");
    }
    return release;
  }

  private async startBrowserbase(apiKey: string): Promise<void> {
    this.browserbase = new Browserbase({ apiKey });
    const persistedSessionId = this.loadPersistedSessionId();

    if (persistedSessionId) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const prior = await this.browserbase.sessions.retrieve(persistedSessionId);
          if (prior.userMetadata?.networkLogging !== "false" || prior.userMetadata?.sessionRecording !== "false")
            throw new Error("Session logging and recording settings cannot be verified.");
          if (personalBrowserEnabled() && (prior.userMetadata?.onepasswordExtension !== process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID || prior.userMetadata?.privateContext !== "true"))
            throw new Error("The personal 1Password browser settings cannot be verified.");
          const browser = await stagehandBrowserbase.connect({
            apiKey,
            sessionId: persistedSessionId,
          });
          await this.attachStagehand(browser);
          this.remoteSessionId = persistedSessionId;
          addTrace(
            this.state,
            "browser",
            "browser.reattach",
            "Reattached Stagehand v4 to the saved Browserbase session.",
            { sessionId: persistedSessionId, attempt },
          );
          return;
        } catch {
          await this.stagehand?.close().catch(() => undefined);
          await this.browser?.close().catch(() => undefined);
          this.stagehand = undefined;
          this.browser = undefined;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      this.remoteSessionId = persistedSessionId;
      await this.releaseRemoteSession();
      addTrace(
        this.state,
        "system",
        "browser.replace",
        "The saved Browserbase session expired. Bell is starting a replacement with the same Context.",
        {
          contextPreserved: Boolean(this.options.contextId ?? process.env.BROWSERBASE_CONTEXT_ID),
        },
      );
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let launched: StagehandBrowser | undefined;
      try {
        launched = await stagehandBrowserbase.launch(
          browserbaseLaunchOptions(apiKey, this.options.contextId, this.options.proxyLocation),
        );
        await this.attachStagehand(launched);
        if (!launched.sessionId)
          throw new Error("Stagehand did not return a Browserbase session ID.");
        this.remoteSessionId = launched.sessionId;
        this.persistSessionId(launched.sessionId);
        return;
      } catch (error) {
        lastError = error;
        await this.stagehand?.close().catch(() => undefined);
        await launched?.close().catch(() => undefined);
        this.stagehand = undefined;
        this.browser = undefined;
        if (launched?.sessionId) {
          this.remoteSessionId = launched.sessionId;
          await this.releaseRemoteSession();
        }
        if (attempt < 3) {
          addTrace(
            this.state,
            "system",
            "browser.start.retry",
            `The Browserbase connection failed. Bell will retry with a new verified, proxied session (${attempt}/3).`,
            { attempt, proxies: true, verified: true },
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async attachStagehand(browser: StagehandBrowser): Promise<void> {
    try {
      const stagehand = await Stagehand.create({
        browser,
        logging: { level: "off" },
      });
      await this.clearCaptchaSubscriptions();
      this.browser = browser;
      this.stagehand = stagehand;
      await this.ensureCaptchaSubscriptions();
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  drainCaptchaTransitions(): BrowserCaptchaTransition[] {
    const page = safeCaptchaPage(this.state.browser.url);
    return this.captchaTransitions
      .splice(0)
      .map((event) => (event.page ? event : { ...event, page }));
  }

  private async ensureCaptchaSubscriptions(): Promise<void> {
    if (!this.browser) return;
    for (const page of await this.browser.context.pages()) {
      if (this.captchaSubscriptions.has(page.pageId)) continue;
      const subscription = await page.on("console", (event) => {
        const signal = parseBrowserbaseCaptchaEvent(event);
        if (signal) this.recordCaptchaSignal(signal);
      });
      this.captchaSubscriptions.set(page.pageId, subscription);
    }
  }

  private recordCaptchaSignal(signal: CaptchaSignal): void {
    const at = new Date().toISOString();
    const page = safeCaptchaPage(this.state.browser.url);
    if (signal === "started") {
      if (this.captchaStatus === "solving") return;
      this.captchaStatus = "solving";
      this.captchaStartedAt = at;
      this.captchaTransitions.push({
        id: crypto.randomUUID(),
        type: "started",
        at,
        page,
      });
      addTrace(this.state, "browser", "captcha.started", "Browserbase is solving a CAPTCHA.", page);
    } else if (signal === "finished" && this.captchaStatus === "solving") {
      this.captchaStatus = "solved";
      this.captchaNeedsObservation = true;
      this.captchaTransitions.push({
        id: crypto.randomUUID(),
        type: "finished",
        at,
        page,
      });
      addTrace(this.state, "browser", "captcha.finished", "Browserbase solved the CAPTCHA.", page);
    } else if (signal === "errored" && this.captchaStatus === "solving") {
      this.captchaStatus = "errored";
      this.captchaTransitions.push({
        id: crypto.randomUUID(),
        type: "errored",
        at,
        page,
      });
      addTrace(
        this.state,
        "error",
        "captcha.errored",
        "Browserbase CAPTCHA solving errored; human input is required.",
        page,
      );
    }
  }

  private async gateCaptcha(): Promise<void> {
    await this.ensureCaptchaSubscriptions();
    if (this.captchaStatus === "solving") {
      const started = Date.parse(this.captchaStartedAt ?? new Date().toISOString());
      while (
        this.captchaStatus === "solving" &&
        Date.now() - started < configuredCaptchaTimeoutMs()
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.captchaStatus === "solving") {
        const at = new Date().toISOString();
        this.captchaStatus = "timed_out";
        const page = safeCaptchaPage(this.state.browser.url);
        this.captchaTransitions.push({
          id: crypto.randomUUID(),
          type: "timed_out",
          at,
          page,
        });
        addTrace(
          this.state,
          "error",
          "captcha.timed_out",
          "CAPTCHA solving timed out; human input is required.",
          page,
        );
      }
    }
    if (this.captchaStatus === "errored" || this.captchaStatus === "timed_out")
      throw new CaptchaHandoffError(this.captchaStatus);
    if (this.captchaNeedsObservation) {
      this.captchaNeedsObservation = false;
      const result = await this.requireStagehand().experimentalBatch(async ({ page }) => ({
        snapshot: await page.snapshot({ includeIframes: true }),
        url: await page.url(),
        title: await page.title(),
      }));
      this.xpathMap = result.snapshot.xpathMap;
      this.updateBrowserState(result.url, result.title);
      addTrace(
        this.state,
        "browser",
        "captcha.observed",
        `Read the post-CAPTCHA page after the current gate.`,
        {
          page: safeCaptchaPage(result.url),
          treePreview: result.snapshot.formattedTree.slice(0, 800),
        },
      );
    }
  }

  private async clearCaptchaSubscriptions(): Promise<void> {
    const subscriptions = [...this.captchaSubscriptions.values()];
    this.captchaSubscriptions.clear();
    await Promise.all(
      subscriptions.map((subscription) => subscription.unsubscribe().catch(() => undefined)),
    );
  }

  private async releaseRemoteSession(): Promise<void> {
    const sessionId = this.remoteSessionId ?? this.loadPersistedSessionId();
    if (!sessionId) return;
    this.browserbase ??= new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
    try {
      await this.browserbase.sessions.update(sessionId, { status: "REQUEST_RELEASE" });
    } catch (error) {
      // An already removed session is released. Keep the ID on every other
      // failure so cleanup can retry instead of silently orphaning the browser.
      if (!(error instanceof Browserbase.APIError) || error.status !== 404)
        throw new Error("The hosted browser could not be released. Retry cleanup.");
    }
    this.remoteSessionId = undefined;
    this.clearPersistedSessionId();
  }

  private loadPersistedSessionId(): string | undefined {
    return this.state.browser.sessionId;
  }

  private persistSessionId(sessionId: string): void {
    this.state.browser.sessionId = sessionId;
  }

  private clearPersistedSessionId(): void {
    delete this.state.browser.sessionId;
  }

  private updateBrowserState(url: string, title: string): BrowserState {
    this.state.browser.url = url;
    this.state.browser.title = title || "Untitled";
    this.state.browser.status = "active";
    return this.state.browser;
  }
}

export function formatRunCode(actions: RunAction[]): string {
  return actions
    .flatMap((item) => {
      switch (item.action) {
        case "goto":
          return [
            `await page.goto(${JSON.stringify(safeActivityUrl(item.url))});`,
            'await page.waitForLoadState("domcontentloaded", 15_000);',
          ];
        case "click":
          return `await page.locator(${JSON.stringify(item.target)}).click();`;
        case "fill":
          return `await page.locator(${JSON.stringify(item.target)}).fill("[value hidden]");`;
        case "type":
          return `await page.locator(${JSON.stringify(item.target)}).type("[value hidden]");`;
        case "press":
          return [
            ...(item.target ? [`await page.locator(${JSON.stringify(item.target)}).click();`] : []),
            'await page.keyPress("[key hidden]");',
          ];
        case "select":
          return `await page.locator(${JSON.stringify(item.target)}).selectOption("[value hidden]");`;
        case "wait":
          return `await page.waitForTimeout(${Math.min(item.milliseconds, 10_000)});`;
      }
    })
    .join("\n");
}

function safeActivityUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (/(?:auth|code|key|otp|password|secret|token)/i.test(key))
        url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function configuredCaptchaTimeoutMs(): number {
  const value = Number(process.env.BELL_CAPTCHA_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function browserProvider(): "local" | "browserbase" {
  if (process.env.STAGEHAND_BROWSER === "local") return "local";
  if (process.env.STAGEHAND_BROWSER === "browserbase") return "browserbase";
  return process.env.BROWSERBASE_API_KEY ? "browserbase" : "local";
}

export function browserbaseLaunchOptions(
  apiKey: string,
  durableContextId?: string,
  proxyLocation?: BrowserProxyLocation,
) {
  const contextId = durableContextId ?? process.env.BROWSERBASE_CONTEXT_ID;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (personalBrowserEnabled() && contextId) throw new Error("Personal 1Password cannot use a reusable Context.");
  return {
    apiKey,
    ...(personalBrowserEnabled() ? { extensionId: process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID!.trim() } : {}),
    ...(projectId ? { projectId } : {}),
    proxies: proxyLocation
      ? [
          {
            type: "browserbase" as const,
            geolocation: proxyLocation,
          },
        ]
      : true,
    keepAlive: true,
    browserSettings: {
      verified: true,
      logSession: false,
      recordSession: false,
      solveCaptchas: true,
      ...(contextId ? { context: { id: contextId, persist: true } } : {}),
    },
    userMetadata: {
      product: "bell",
      transport: "stagehand-v4-eve",
      networkLogging: "false",
      sessionRecording: "false",
      ...(personalBrowserEnabled() ? { onepasswordExtension: process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID!.trim(), privateContext: "true" } : {}),
    },
  };
}

export function assessSnapshot(tree: string, url: string): { blocked: boolean; signal?: string } {
  const text = `${url}\n${tree}`.toLowerCase();
  if (
    tree.includes("(No visible page text)") &&
    tree.includes("(No visible interactive targets)") &&
    /^https?:\/\//i.test(url)
  ) {
    return { blocked: true, signal: "empty page" };
  }
  const signals: Array<[string, RegExp]> = [
    ["access blocked", /you have been blocked|access (?:is )?denied|request blocked/],
    ["bot challenge", /verify (?:that )?you are human|unusual traffic|robot or human|captcha/],
    ["challenge page", /just a moment|checking your browser|enable javascript and cookies/],
    [
      "navigation error",
      /chrome-error:\/\/chromewebdata|privacy error|your connection is not private/,
    ],
    ["login wall", /\/login(?:\?|\s)|log in to .{1,80}(?:email|phone|continue)/],
    ["not found", /page not found|404 not found|the page you requested (?:was|could not be) found/],
  ];
  const match = signals.find(([, pattern]) => pattern.test(text));
  return match ? { blocked: true, signal: match[0] } : { blocked: false };
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function isLiveSourceUrl(url: string): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (host.includes("google.")) return /^\/maps\/place\//.test(parsed.pathname);
  return !DISCOVERY_HOSTS.some((item) => host.includes(item));
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Buffer.from(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return Buffer.from(record.data as number[]);
    const numericValues = Object.values(record);
    if (numericValues.length && numericValues.every((item) => typeof item === "number")) {
      return Buffer.from(numericValues as number[]);
    }
  }
  throw new Error("Stagehand returned a screenshot in an unsupported byte format.");
}

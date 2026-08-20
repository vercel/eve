import {
  browserbase,
  localBrowser,
  Stagehand,
  type StagehandBrowser,
} from "@browserbasehq/stagehand";

interface StagehandResources {
  browser: StagehandBrowser;
  stagehand: Stagehand;
}

let resourcesPromise: Promise<StagehandResources> | undefined;

export async function getStagehandResources(): Promise<StagehandResources> {
  const resources = await (resourcesPromise ??= createStagehandResources());
  if (!resources.browser.closed) {
    return resources;
  }

  resourcesPromise = createStagehandResources();
  return resourcesPromise;
}

async function createStagehandResources(): Promise<StagehandResources> {
  const browser = await createBrowser();
  try {
    const stagehand = await Stagehand.create({ browser });
    return { browser, stagehand };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function createBrowser(): Promise<StagehandBrowser> {
  const requestedBrowser = process.env.STAGEHAND_BROWSER;
  if (
    requestedBrowser !== undefined &&
    requestedBrowser !== "local" &&
    requestedBrowser !== "browserbase"
  ) {
    throw new Error('STAGEHAND_BROWSER must be either "local" or "browserbase".');
  }

  const apiKey = process.env.BROWSERBASE_API_KEY;
  const browserType = requestedBrowser ?? (apiKey ? "browserbase" : "local");
  if (browserType === "local") {
    return localBrowser.launch({ headless: false });
  }
  if (!apiKey) {
    throw new Error('BROWSERBASE_API_KEY is required when STAGEHAND_BROWSER="browserbase".');
  }

  return browserbase.launch({
    apiKey,
    ...(process.env.BROWSERBASE_PROJECT_ID
      ? { projectId: process.env.BROWSERBASE_PROJECT_ID }
      : {}),
    keepAlive: true,
  });
}

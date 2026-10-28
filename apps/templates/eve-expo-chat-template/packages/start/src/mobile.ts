/** The exported Expo client this deployment serves to Expo Go. */
export type MobileBundle = {
  id: string;
  createdAt: string;
  sdkVersion: string;
  config: Record<string, unknown> & { slug?: string };
  platforms: Record<
    "ios" | "android",
    {
      bundle: { file: string; hash: string };
      assets: {
        file: string;
        hash: string;
        key: string;
        fileExtension: string;
        contentType: string;
      }[];
    }
  >;
  files: Record<string, { contentType: string; body: string }>;
};

export const MOBILE_PATH = "/start/mobile";

/** Expo Go loads the manifest from the URL before `/--/`; the suffix becomes the app's deep link. */
export function hostedExpoGoUrl(origin: string): URL {
  const { protocol, host } = new URL(origin);
  // URL cannot switch a special scheme (https) to a custom one, so build it from text.
  return new URL((protocol === "https:" ? "exps://" : "exp://") + host + MOBILE_PATH + "/--/pair");
}

export function mobileManifest(bundle: MobileBundle, platform: "ios" | "android", origin: string) {
  const files = new URL(MOBILE_PATH + "/files/", origin);
  const build = bundle.platforms[platform];
  return {
    id: bundle.id,
    createdAt: bundle.createdAt,
    runtimeVersion: "exposdk:" + bundle.sdkVersion,
    launchAsset: {
      key: "bundle",
      hash: build.bundle.hash,
      contentType: "application/javascript",
      url: new URL(build.bundle.file, files).toString(),
    },
    assets: build.assets.map(({ file, ...asset }) => ({
      ...asset,
      url: new URL(file, files).toString(),
    })),
    metadata: {},
    extra: {
      expoClient: { ...bundle.config, sdkVersion: bundle.sdkVersion },
      // Expo Go keys local storage by scope; one deployment origin is one app installation.
      scopeKey: "@anonymous/" + (bundle.config.slug || "eve-expo") + "-" + new URL(origin).host,
    },
  };
}

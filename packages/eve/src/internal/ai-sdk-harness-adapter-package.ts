const AI_SDK_HARNESS_ADAPTER_PACKAGE_PREFIX = "@ai-sdk/harness-";

export const AI_SDK_HARNESS_ADAPTER_TRACE_PATTERN = /@ai-sdk[/\\]harness-[^/\\]+/;

export function isAiSdkHarnessAdapterPackageName(packageName: string): boolean {
  return (
    packageName.startsWith(AI_SDK_HARNESS_ADAPTER_PACKAGE_PREFIX) &&
    packageName.length > AI_SDK_HARNESS_ADAPTER_PACKAGE_PREFIX.length
  );
}

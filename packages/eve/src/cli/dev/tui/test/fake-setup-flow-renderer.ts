import type { SetupFlowRenderer } from "../setup-flow.js";

export function createFakeSetupFlowRenderer(
  overrides: Partial<SetupFlowRenderer> = {},
): SetupFlowRenderer {
  const {
    readProviderPicker = async () => undefined,
    readModelPicker = async () => undefined,
    ...rest
  } = overrides;
  return {
    begin: () => {},
    end: () => {},
    readSelect: async () => undefined,
    readEditableSelect: async () => undefined,
    readProviderPicker,
    readModelPicker,
    readText: async () => undefined,
    readAcknowledge: async () => {},
    readChoice: () => ({ choice: Promise.resolve(undefined), close: () => {} }),
    setStatus: () => {},
    renderLine: () => {},
    renderOutput: () => {},
    withInheritedStdio: (task) => task(),
    waitForInterrupt: () => ({
      promise: new Promise<"escape" | "ctrl-c">(() => {}),
      dispose: () => {},
    }),
    ...rest,
  };
}

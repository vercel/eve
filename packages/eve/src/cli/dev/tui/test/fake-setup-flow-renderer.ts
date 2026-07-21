import type { SetupFlowRenderer } from "../setup-flow.js";

export function createFakeSetupFlowRenderer(
  overrides: Partial<SetupFlowRenderer> = {},
): SetupFlowRenderer {
  const {
    readProviderPicker = async () => undefined,
    readModelEditor = async () => undefined,
    ...rest
  } = overrides;
  return {
    begin: () => {},
    end: () => {},
    readSelect: async () => undefined,
    readEditableSelect: async () => undefined,
    readProviderPicker,
    readModelEditor,
    readText: async () => undefined,
    readAcknowledge: async () => {},
    readChoice: () => ({ choice: Promise.resolve(undefined), close: () => {} }),
    setStatus: () => {},
    renderLine: () => {},
    renderOutput: () => {},
    waitForInterrupt: () => ({
      promise: new Promise<void>(() => {}),
      dispose: () => {},
    }),
    ...rest,
  };
}

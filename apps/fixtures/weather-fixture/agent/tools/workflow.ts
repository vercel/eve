// Enables the framework `Workflow` orchestration tool for this agent. The
// `ExperimentalWorkflow` marker is re-exported as this file's default export;
// the compiler recognizes it and exposes a code-mode-style sandbox whose only
// callable operations are this agent's subagents (here: the `agent`
// self-delegation tool and the `stock-price` subagent). The model-facing tool
// is named `Workflow`.
export { ExperimentalWorkflow as default } from "eve/tools";

import type { ModelRouting } from "#shared/agent-definition.js";
import { parseModelHelper } from "#shared/model-helper.js";
import { inspectApplication } from "#services/inspect-application.js";

import { readAuthoredModelSelection } from "./model-source-change.js";

interface CurrentAgentModel {
  readonly editable: boolean;
  readonly routing: ModelRouting | null;
}

async function readCurrentAgentModel(appRoot: string): Promise<CurrentAgentModel> {
  try {
    const { compiledState } = await inspectApplication(appRoot);
    const config = compiledState?.manifest.config;
    const model = config?.model;
    const authored =
      model?.source === undefined ? undefined : await readAuthoredModelSelection(appRoot);
    const helper = authored === undefined ? undefined : parseModelHelper(authored)?.helper;
    return {
      routing: model?.routing ?? null,
      editable: model !== undefined && (model.source === undefined || helper !== undefined),
    };
  } catch {
    return {
      routing: null,
      editable: false,
    };
  }
}

export async function modelChangeRefusalForUneditableModel(
  appRoot: string,
): Promise<string | null> {
  const { editable, routing } = await readCurrentAgentModel(appRoot);
  if (editable) return null;
  const detail =
    routing?.kind === "external"
      ? `the external provider \`${routing.provider}\``
      : "an SDK model call";
  return `Model is set via ${detail} in agent.ts, not a string literal; /model can't rewrite it. Edit \`model\` in agent.ts.`;
}

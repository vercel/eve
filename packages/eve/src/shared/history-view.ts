import type { ModelMessage } from "ai";

export interface HistoryViewProjectionInput {
  readonly messages: readonly ModelMessage[];
  readonly state: Readonly<Record<string, unknown>> | undefined;
}

export type HistoryViewProjector = (input: HistoryViewProjectionInput) => readonly ModelMessage[];

export interface PreparedHistoryView {
  readonly messages: readonly ModelMessage[];
  readonly sourceMessages: readonly ModelMessage[];
  readonly sourceState: Readonly<Record<string, unknown>> | undefined;
}

export const identityHistoryViewProjector: HistoryViewProjector = ({ messages }) => messages;

export function createHistoryViewPreparer(input?: {
  readonly previous?: PreparedHistoryView;
  readonly projector?: HistoryViewProjector;
}): (
  messages: readonly ModelMessage[],
  state: Readonly<Record<string, unknown>> | undefined,
) => PreparedHistoryView {
  let previous = input?.previous;

  return (messages, state) => {
    previous = prepareHistoryView({
      messages,
      previous,
      projector: input?.projector,
      state,
    });
    return previous;
  };
}

export function prepareHistoryView(input: {
  readonly messages: readonly ModelMessage[];
  readonly previous?: PreparedHistoryView;
  readonly projector?: HistoryViewProjector;
  readonly state?: Readonly<Record<string, unknown>>;
}): PreparedHistoryView {
  if (
    input.previous?.sourceMessages === input.messages &&
    input.previous.sourceState === input.state
  ) {
    return input.previous;
  }

  const projector = input.projector ?? identityHistoryViewProjector;
  return {
    messages: projector({ messages: input.messages, state: input.state }),
    sourceMessages: input.messages,
    sourceState: input.state,
  };
}

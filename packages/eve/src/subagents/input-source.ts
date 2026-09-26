// Shared across separately bundled copies of the emitter and subagent adapter.
const inputSourceKey = Symbol.for("eve.subagents.inputSource");

type InputSourceCarrier = { readonly [inputSourceKey]?: string };

export function withInputSource<T extends object>(context: T, inputSource: string | undefined): T {
  return inputSource === undefined ? context : { ...context, [inputSourceKey]: inputSource };
}

export function readInputSource(context: object): string | undefined {
  return (context as InputSourceCarrier)[inputSourceKey];
}

// An emitter and the subagent adapter can be bundled separately.
const inputSourceKey = Symbol.for("eve.subagents.inputSource");

type InputSourceCarrier = { readonly [inputSourceKey]?: string };

export function withInputSource<T extends object>(context: T, source: string | undefined): T {
  return source === undefined ? context : { ...context, [inputSourceKey]: source };
}

export function readInputSource(context: object): string | undefined {
  return (context as InputSourceCarrier)[inputSourceKey];
}

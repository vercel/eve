import { DISPATCHER_PROBE_URL } from "#execution/public-destination.js";

type FetchInput = string | URL | Request;

interface ProbeHandler {
  onResponseError(controller: undefined, error: Error): void;
}

interface DispatcherLike {
  dispatch(options: unknown, handler: ProbeHandler): boolean;
}

function isDispatcher(value: unknown): value is DispatcherLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispatch" in value &&
    typeof value.dispatch === "function"
  );
}

export function answerDispatcherProbe(
  respond: (input: FetchInput, init?: RequestInit) => Promise<Response>,
): (input: FetchInput, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const dispatcher: unknown = init === undefined ? undefined : Reflect.get(init, "dispatcher");
    if (String(input) === DISPATCHER_PROBE_URL && isDispatcher(dispatcher)) {
      return await new Promise<Response>((_resolve, reject) => {
        dispatcher.dispatch(
          {},
          {
            onResponseError: (_controller, error) =>
              reject(new TypeError("fetch failed", { cause: error })),
          },
        );
      });
    }
    return await respond(input, init);
  };
}

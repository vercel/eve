export async function withinTimeout<Result>(
  ms: number,
  message: string,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

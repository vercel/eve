/**
 * Serializes every authored-source mutation this extension performs.
 *
 * The model may call `selfmod__edit_file` and `selfmod__registry_add` in the
 * same response. An install rewrites `package.json`, runs the package manager,
 * and holds the authored-source watcher suspended for its whole duration, so an
 * edit landing in the middle of one is compiled against a tree that is being
 * replaced underneath it. The extension bundle emits shared imports as one
 * chunk, so both tools observe this single queue.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every previously queued authored-source mutation settles. */
export async function withAuthoredSourceLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return await run;
}

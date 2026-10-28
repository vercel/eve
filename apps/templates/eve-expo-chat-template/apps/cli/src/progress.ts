import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { stripVTControlCharacters } from "node:util";

/** A small live log window in terminals; ordinary logs when piped. */
export function setupProgress(stream = process.stderr) {
  const interactive = Boolean(stream.isTTY && process.env.TERM !== "dumb");
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let label = "Setting up eve Start…",
    lines: string[] = [],
    partial = "",
    frame = 0,
    drawn = 0,
    stopped = false;
  const clean = (text: string) =>
    stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  function render(final = false) {
    if (!interactive) return;
    if (drawn) {
      moveCursor(stream, 0, -drawn);
      cursorTo(stream, 0);
      clearScreenDown(stream);
    }
    const tail = [...lines, ...(partial ? [partial] : [])].slice(-5);
    const width = Math.max(10, (stream.columns || 80) - 2);
    const display = [
      `${final ? " " : frames[frame++ % frames.length]} ${label}`,
      ...tail.map((line) => `  ${line}`),
    ].map((line) => (line.length > width ? line.slice(0, width - 1) + "…" : line));
    stream.write(display.join("\n") + "\n");
    drawn = display.length;
  }
  const timer = interactive ? setInterval(() => render(), 80) : undefined;
  timer?.unref();
  render();
  return {
    step(message: string) {
      if (!interactive || stopped) {
        stream.write(clean(message) + "\n");
        return;
      }
      label = clean(message).replace(/\n/g, " ");
      lines = [];
      partial = "";
      render();
    },
    output(chunk: string) {
      const text = clean(chunk.replace(/\r\n?/g, "\n"));
      if (!interactive || stopped) {
        stream.write(text);
        return;
      }
      const parts = (partial + text).split("\n");
      partial = parts.pop()!.slice(-2000);
      lines = [...lines, ...parts.filter(Boolean).map((line) => line.slice(0, 2000))].slice(-5);
    },
    stop() {
      if (stopped) return;
      clearInterval(timer);
      render(true);
      stopped = true;
    },
  };
}

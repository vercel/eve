import readFile from "eve/tools/read_file";

/**
 * Sandbox file reading, which is how this specialist opens its skills' `references/` files.
 *
 * @remarks
 * The agent sets `defaultTools: false`, so each built-in it needs is added back by a file like this
 * one. `write_file`, `edit_file`, and `bash` stay off: nothing this specialist does writes to the
 * sandbox. The built-in is bound to a local name before the export because the lint rules reject
 * exporting an import directly.
 *
 * @see {@link https://eve.dev/docs/concepts/built-in-tools | Built-in tools}
 */
const readFileTool = readFile;

export default readFileTool;

import readFile from "eve/tools/read_file";

/**
 * File read for the reviewer: reads its skill's reference files from its sandbox.
 *
 * @remarks
 * The reviewer sets `defaultTools: false`, so this file is what gives it `read_file`, the only
 * built-in tool it has. The built-in is bound to a local constant because the lint preset
 * rejects both exporting an import directly and a bare re-export.
 */
const readFileTool = readFile;

export default readFileTool;

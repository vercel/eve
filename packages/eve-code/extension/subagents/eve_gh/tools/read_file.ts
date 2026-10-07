import readFile from "eve/tools/read_file";
import { withEveGhAuth } from "../../../lib/eve-gh-auth.ts";

export default withEveGhAuth(readFile);

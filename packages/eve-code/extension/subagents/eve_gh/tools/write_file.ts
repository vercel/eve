import writeFile from "eve/tools/write_file";
import { withEveGhAuth } from "../../../lib/eve-gh-auth.ts";

export default withEveGhAuth(writeFile);

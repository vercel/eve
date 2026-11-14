import link from "@stripe/link-integrations-eve";
import { linkAuth } from "../../lib/link-auth";

export default link({ auth: linkAuth });

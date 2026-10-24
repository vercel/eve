import { defineDynamic } from "eve/tools";
import { definitions } from "../../../lib/arms";
export default defineDynamic({ events: { "session.started": () => definitions("d0") } });

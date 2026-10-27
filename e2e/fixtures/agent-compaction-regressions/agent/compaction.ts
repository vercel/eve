import { e2eModel } from "@eve-e2e/config";
import { fixedTail } from "eve/compaction";

export default fixedTail({ model: e2eModel() });

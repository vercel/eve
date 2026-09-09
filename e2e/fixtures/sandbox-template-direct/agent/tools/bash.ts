import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { bash } from "eve/tools/bash";

export default defineTool({ ...bash, approval: never() });

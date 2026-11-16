import { webSearch } from "eve/tools/web_search";

/**
 * Web search for the researcher, run by Parallel through the AI Gateway.
 *
 * @remarks
 * The researcher sets `defaultTools: false`, so this file is what gives it search. Parallel works
 * with any Gateway model, which matters here because the researcher's model is chosen per call.
 */
export default webSearch({ provider: "parallel" });

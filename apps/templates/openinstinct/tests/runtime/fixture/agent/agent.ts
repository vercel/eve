import { defineAgent } from "eve";
import { fixtureModel } from "./lib/model";

export default defineAgent({ defaultTools: false, model: fixtureModel(false) });

import arcana from "@kybernesis/arcana";

export default arcana({
  apiKey: process.env.ARCANA_API_KEY!,
  workspace: process.env.ARCANA_WORKSPACE!,
});

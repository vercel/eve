import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

export default defineEval({
  description:
    "upload_asset refuses a reserved path and names the tool that owns it.",
  async test(t) {
    await t.send(
      toolScript("seo", {
        message: toolScript("upload_asset", {
          content: "not the brand context",
          pathname: "brand-context/brand.md",
        }),
      })
    );
    t.calledAgent("seo", {
      output: (value) => {
        const text =
          typeof value === "string" ? value : String(JSON.stringify(value));
        return (
          text.includes('"success":false') &&
          text.includes("save_brand_context")
        );
      },
    });
  },
});

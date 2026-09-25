import { benchmarkResults, benchmarkRows } from "@/lib/evals/results";
import { createEvalsOgImage } from "@/lib/evals/og-image";

export const size = {
  width: 1200,
  height: 628,
};
export const contentType = "image/png";

const EvalsTwitterImage = () => createEvalsOgImage(benchmarkRows(benchmarkResults));

export default EvalsTwitterImage;

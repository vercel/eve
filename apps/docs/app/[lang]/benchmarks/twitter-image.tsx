import { eveBenchmark, orderedModels } from "@/lib/evals/eve-results";
import { createBenchmarksOgImage } from "@/lib/evals/og-image";

export const size = {
  width: 1200,
  height: 628,
};
export const contentType = "image/png";

const BenchmarksTwitterImage = () => {
  const dataset = eveBenchmark.datasets["deepswe-lean"];
  return createBenchmarksOgImage(dataset ? orderedModels(dataset) : []);
};

export default BenchmarksTwitterImage;

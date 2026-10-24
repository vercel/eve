// eve-self-modification: generated-v1 digest:14bd37b0182dd48678b8e62f9f546b401e89320ed793097c24d592542a804d97
import selfModification from "eve/self-modification/remote";

export default selfModification({
  // Keep delegation disabled until setup configures the repository and authorization policy.
  authorize: () => false,
  github: {
    repository: "your-org/your-repo",
    connector: "github/your-connector",
  },
  directory: ".",
  baseBranch: "main",
  // model: "provider/model",
  // reasoning: "high",
});

import { defineDynamic, defineSkill } from "eve/skills";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Vercel Drive fork fixture.",
        files: {
          "references/drive.txt": "vercel-image-dynamic-skill-ok-D7K\n",
        },
        markdown: "# Dynamic Drive fixture",
      }),
  },
});

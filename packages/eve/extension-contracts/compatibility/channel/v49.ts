import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 49 route args had describe and invokeTool but no listSkillFiles or readSkill.
export default defineChannel({
  routes: [
    GET("/status", async (_request, { describe, invokeTool }) => {
      const { tools } = await describe();
      return Response.json({
        tools: tools.length,
        canInvokeTools: typeof invokeTool === "function",
      });
    }),
  ],
});

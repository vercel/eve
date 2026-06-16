import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import getWeather from "../tools/get_weather.js";

/**
 * Lightweight audit hook for the weather-fixture.
 *
 * Records session and turn boundaries to stdout so an operator
 * watching `vercel logs` can confirm the lifecycle is firing
 * end-to-end. Stream-event hooks are observe-only — errors thrown
 * here propagate through the emit composer and would fail the
 * current turn, so the bodies stay defensive (just structured logs).
 */
export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      console.info("weather-fixture session started", {
        sessionId: ctx.session.id,
        channel: ctx.channel.kind,
      });
    },

    async "action.result"(event, _ctx) {
      const weather = toolResultFrom(event.data.result, getWeather);
      if (weather) {
        console.info("weather lookup", {
          city: weather.output.city,
          temperatureF: weather.output.temperatureF,
          condition: weather.output.condition,
        });
      }
    },

    async "turn.completed"(event, ctx) {
      console.info("weather-fixture turn completed", {
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        sequence: event.data.sequence,
      });
    },

    async "session.failed"(event, ctx) {
      console.warn("weather-fixture session failed", {
        sessionId: ctx.session.id,
        message: event.data.message,
      });
    },
  },
});

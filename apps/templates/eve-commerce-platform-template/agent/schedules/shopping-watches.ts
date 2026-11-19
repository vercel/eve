import { defineSchedule } from "eve/schedules";
import { readVerifiedShopperPhone } from "@/lib/auth/users";
import { env } from "@/lib/environment/env";
import { directLinqChatId, isDirectLinqThread, sendNativeLinqMessage } from "@/lib/linq/transport";
import { evaluateWatch } from "@/lib/watches/match";
import { readProductOffer } from "@/lib/watches/product-page";
import {
  claimDueWatches,
  finishNotification,
  readPendingAlert,
  saveCheck,
} from "@/lib/watches/store";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    if (!env.LINQ_CONNECTOR) return;
    await Promise.allSettled((await claimDueWatches()).map(checkWatch));
  },
});

async function checkWatch(watch: Awaited<ReturnType<typeof claimDueWatches>>[number]) {
  if (!watch.leaseToken) return;
  const token = watch.leaseToken;
  if (watch.status === "active") {
    const offer = await readProductOffer(watch.productUrl).catch(() => undefined);
    const result = evaluateWatch(watch, offer);
    const saved = await saveCheck(watch.id, token, result);
    if (typeof result === "string" || !saved) return;
  }

  try {
    const phone = await readVerifiedShopperPhone(watch.shopperId);
    const chatId = directLinqChatId(watch.threadId);
    if (!phone || !chatId || !(await isDirectLinqThread(watch.threadId, phone))) {
      await finishNotification(watch.id, token, "stopped");
      return;
    }
    const alert = await readPendingAlert(watch.id, token);
    if (!alert) return;
    await sendNativeLinqMessage(
      chatId,
      {
        idempotency_key: `shopping-watch:${watch.id}`,
        parts: [{ type: "text", value: alert }],
      },
      { maxRetries: 0, timeout: 8_000 },
    );
    await finishNotification(watch.id, token, "sent");
  } catch {
    await finishNotification(watch.id, token, "retry");
    console.warn("[shopping-watches] alert could not be delivered", { watchId: watch.id });
  }
}

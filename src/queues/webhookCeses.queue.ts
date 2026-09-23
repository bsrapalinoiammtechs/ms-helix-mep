import { Queue, QueueEvents, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";

/**
 * Cola para CESES (resolución) de alertas recibidos por webhook de Meraki.
 * Endpoint separado del de activas (`webhookAlerts.queue.ts`) a propósito
 * -- ver 01_FIX_ALERTAS_RETENIDAS_2026-05-12.md, sección FASE C: todavía no
 * está confirmado si Meraki manda el mismo `alertType` para "raised" y
 * "resolved" o si son eventos/payloads distintos, así que separar el
 * endpoint deja la puerta abierta a asignarlos como receptores distintos en
 * Meraki si hiciera falta, sin tocar código.
 */

export const WEBHOOK_CESES_QUEUE_NAME = "meraki-webhook-ceses";

export const webhookCesesQueue = new Queue(WEBHOOK_CESES_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

export const webhookCesesQueueEvents = new QueueEvents(WEBHOOK_CESES_QUEUE_NAME, {
  connection: redisConnection,
});

webhookCesesQueueEvents.on("error", (err) => {
  log.error("webhook_ceses.queue_events.error", { message: err?.message });
});

export async function enqueueWebhookCese(payload: MerakiWebhookAlertPayload): Promise<Job> {
  return webhookCesesQueue.add("cese-alert", payload);
}

export async function closeWebhookCesesQueue() {
  await webhookCesesQueueEvents.close();
  await webhookCesesQueue.close();
}

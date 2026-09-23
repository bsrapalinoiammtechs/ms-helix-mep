import { Queue, QueueEvents, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";
import { IAlertHelix } from "../interfaces/IAlertHelix";

/**
 * Cola para reenviar hacia EPISTECH (vía `EpistechWebHook`, ver
 * EPISTECH/EpistechWebHook/src/routes/webhook.ts -> POST /webhook/receive)
 * el MISMO payload que ya se le manda a ms-helix-tcp -- caídas y ceses
 * juntos, ambos vienen mezclados en `built` dentro de
 * `validateAndBuildAlertsToSend` (FlowFunctions.ts).
 *
 * Independiente de la cola/lógica de TCP a propósito: el envío a Epistech
 * NO debe bloquear ni condicionar el envío real a Helix (que sigue siendo
 * el canal principal) -- si Epistech está caído o lento, TCP sigue
 * funcionando igual. Por eso es "fire and forget" vía su propia cola, no
 * un `await` en la misma cadena que TCP.
 */

export const EPISTECH_WEBHOOK_QUEUE_NAME = "epistech-webhook-send";

export const epistechWebhookQueue = new Queue(EPISTECH_WEBHOOK_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

export const epistechWebhookQueueEvents = new QueueEvents(EPISTECH_WEBHOOK_QUEUE_NAME, {
  connection: redisConnection,
});

epistechWebhookQueueEvents.on("error", (err) => {
  log.error("epistech_webhook.queue_events.error", { message: err?.message });
});

/**
 * Encola el mismo array de alertas (caídas + ceses) que se le manda a TCP.
 * No hace nada si `EPISTECH_WEBHOOK_ENABLED` no está en "true" -- apagado
 * por defecto hasta que el receptor del lado de Epistech esté listo para
 * procesar datos reales, no solo loguearlos.
 */
export async function enqueueEpistechAlerts(alerts: IAlertHelix[]): Promise<Job | null> {
  if (process.env.EPISTECH_WEBHOOK_ENABLED !== "true") return null;
  if (!alerts?.length) return null;
  return epistechWebhookQueue.add("send-alerts", alerts);
}

export async function closeEpistechWebhookQueue() {
  await epistechWebhookQueueEvents.close();
  await epistechWebhookQueue.close();
}

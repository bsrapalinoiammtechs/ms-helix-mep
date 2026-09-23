import { Queue, QueueEvents, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";

/**
 * Cola para alertas ACTIVAS recibidas por webhook de Meraki (push), en vez
 * de por polling. Independiente de `meraki.queue.ts` (ese es el gateway de
 * SALIDA hacia la API REST de Meraki, con rate-limit propio) -- acá no hay
 * ningún límite de Meraki que respetar, Meraki ya nos empujó el dato. Se
 * encola de todas formas para no bloquear la respuesta HTTP mientras se
 * procesa (catálogo, GLPI, Mongo) -- Meraki espera un 2xx rápido y
 * deshabilita el receptor si falla consistentemente.
 *
 * Solo alertas activas (raised) por ahora -- el cese/resolución queda
 * pendiente de decidir si comparte este mismo flujo o va en un endpoint
 * aparte (ver 01_FIX_ALERTAS_RETENIDAS_2026-05-12.md, sección FASE C).
 */

export const WEBHOOK_ALERTS_QUEUE_NAME = "meraki-webhook-alerts";

export const webhookAlertsQueue = new Queue(WEBHOOK_ALERTS_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // A diferencia del gateway de salida (attempts:1, retries manuales
    // respetando Retry-After), acá SÍ tiene sentido el retry normal de
    // BullMQ: es solo "reintentar guardar/validar", no hay contrato de
    // rate-limit externo que romper.
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

export const webhookAlertsQueueEvents = new QueueEvents(WEBHOOK_ALERTS_QUEUE_NAME, {
  connection: redisConnection,
});

webhookAlertsQueueEvents.on("error", (err) => {
  log.error("webhook_alerts.queue_events.error", { message: err?.message });
});

/**
 * Encola el payload crudo del webhook tal cual llegó -- el mapeo hacia
 * nuestro formato interno (`IAlertCisco`, vía `mapMerakiWebhookAlert`) pasa
 * DENTRO del Worker (`workers/webhookAlerts.worker.ts`), no acá, para que
 * la ruta HTTP responda a Meraki lo más rápido posible.
 */
export async function enqueueWebhookAlert(
  payload: MerakiWebhookAlertPayload,
): Promise<Job> {
  return webhookAlertsQueue.add("raised-alert", payload);
}

export async function closeWebhookAlertsQueue() {
  await webhookAlertsQueueEvents.close();
  await webhookAlertsQueue.close();
}

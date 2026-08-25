import { Queue, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";

/**
 * Cola para el ciclo de envío de alertas a Helix (vía ms-helix-tcp). No
 * tiene relación con el gateway de Meraki (meraki.queue.ts) -- este flujo
 * lee de Mongo y envía por TCP, no llama a la API de Meraki. Se usa BullMQ
 * acá únicamente por trazabilidad: cada corrida queda como un job con su
 * propia bitácora (job.log) visible en bull-board, en vez de perderse en
 * el log de consola general.
 */

export const SEND_ALERTS_QUEUE_NAME = "send-alerts-to-helix";

const JOB_WAIT_TIMEOUT_MS = parseInt(
  process.env.SEND_ALERTS_JOB_WAIT_TIMEOUT_MS || String(5 * 60 * 1000),
  10,
); // 5 min -- este flujo no tiene reintentos largos como el de Meraki, no hace falta tanto margen

export const sendAlertsQueue = new Queue(SEND_ALERTS_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

export const sendAlertsQueueEvents = new QueueEvents(SEND_ALERTS_QUEUE_NAME, {
  connection: redisConnection,
});

sendAlertsQueueEvents.on("error", (err) => {
  log.error("send_alerts.queue_events.error", { message: err?.message });
});

/**
 * Encola un ciclo de "revisar pendientes y enviar a Helix" y espera a que
 * termine. Si el ciclo falla, esto relanza el error -- el caller (el cron
 * en index.ts) ya tiene su propio try/catch para loguearlo, igual que
 * antes de este cambio.
 */
export async function enqueueSendAlertsCycle(): Promise<void> {
  const job = await sendAlertsQueue.add("send-cycle", {});
  try {
    await job.waitUntilFinished(sendAlertsQueueEvents, JOB_WAIT_TIMEOUT_MS);
  } catch (error: any) {
    log.error("send_alerts.gateway.job_failed", {
      jobId: job.id,
      message: error?.message,
    });
    throw error;
  }
}

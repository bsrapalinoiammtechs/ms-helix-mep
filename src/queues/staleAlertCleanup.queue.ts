import { Queue, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";

/**
 * Cola para la limpieza de alertas huérfanas por reemplazo de hardware (ver
 * staleAlertCleanup.service.ts). No llama a Meraki -- es puramente local,
 * así que no comparte el gateway de meraki.queue.ts. Se usa BullMQ acá por
 * el mismo motivo que sendAlerts.queue.ts: trazabilidad en bull-board, cada
 * corrida queda como un job con su propia bitácora.
 */

export const STALE_ALERT_CLEANUP_QUEUE_NAME = "stale-alert-cleanup";

const JOB_WAIT_TIMEOUT_MS = parseInt(
  process.env.STALE_ALERT_CLEANUP_JOB_WAIT_TIMEOUT_MS || String(5 * 60 * 1000),
  10,
);

export const staleAlertCleanupQueue = new Queue(STALE_ALERT_CLEANUP_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

export const staleAlertCleanupQueueEvents = new QueueEvents(STALE_ALERT_CLEANUP_QUEUE_NAME, {
  connection: redisConnection,
});

staleAlertCleanupQueueEvents.on("error", (err) => {
  log.error("stale_alert_cleanup.queue_events.error", { message: err?.message });
});

export async function enqueueStaleAlertCleanupCycle(): Promise<void> {
  const job = await staleAlertCleanupQueue.add("cleanup-cycle", {});
  try {
    await job.waitUntilFinished(staleAlertCleanupQueueEvents, JOB_WAIT_TIMEOUT_MS);
  } catch (error: any) {
    log.error("stale_alert_cleanup.gateway.job_failed", {
      jobId: job.id,
      message: error?.message,
    });
    throw error;
  }
}

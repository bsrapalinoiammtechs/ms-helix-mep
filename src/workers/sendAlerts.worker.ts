import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { SEND_ALERTS_QUEUE_NAME } from "../queues/sendAlerts.queue";
import { validateAndBuildAlertsToSend } from "../functions/FlowFunctions";
import { log } from "../utils/logger";

/**
 * Único consumidor de `send-alerts-to-helix`. La lógica de negocio en sí
 * sigue viviendo en `validateAndBuildAlertsToSend` (FlowFunctions.ts) --
 * este worker solo le pasa el `job` para que deje su bitácora paso a paso
 * ahí (visible en la pestaña Logs de bull-board).
 */
export const sendAlertsWorker = new Worker(
  SEND_ALERTS_QUEUE_NAME,
  async (job: Job) => {
    await validateAndBuildAlertsToSend(job);
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

sendAlertsWorker.on("error", (err) => {
  log.error("send_alerts.worker.error", { message: err?.message });
});

sendAlertsWorker.on("failed", (job, err) => {
  log.warn("send_alerts.worker.job_failed", { jobId: job?.id, message: err?.message });
});

log.info("send_alerts.worker.started", {});

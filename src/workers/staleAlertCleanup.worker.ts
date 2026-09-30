import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { STALE_ALERT_CLEANUP_QUEUE_NAME } from "../queues/staleAlertCleanup.queue";
import { cleanupStaleNetworkAlerts } from "../services/staleAlertCleanup.service";
import { log } from "../utils/logger";

/**
 * Único consumidor de `stale-alert-cleanup`. La lógica de negocio vive en
 * `cleanupStaleNetworkAlerts` (staleAlertCleanup.service.ts) -- este worker
 * solo le pasa el `job` para la bitácora en bull-board.
 */
export const staleAlertCleanupWorker = new Worker(
  STALE_ALERT_CLEANUP_QUEUE_NAME,
  async (job: Job) => {
    return cleanupStaleNetworkAlerts(job);
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

staleAlertCleanupWorker.on("error", (err) => {
  log.error("stale_alert_cleanup.worker.error", { message: err?.message });
});

staleAlertCleanupWorker.on("failed", (job, err) => {
  log.warn("stale_alert_cleanup.worker.job_failed", { jobId: job?.id, message: err?.message });
});

log.info("stale_alert_cleanup.worker.started", {});

import { Worker, Job } from "bullmq";
import axios from "axios";
import { redisConnection } from "../config/redis";
import { EPISTECH_WEBHOOK_QUEUE_NAME } from "../queues/epistechWebhook.queue";
import { IAlertHelix } from "../interfaces/IAlertHelix";
import { log } from "../utils/logger";

/**
 * Consume `epistech-webhook-send`: hace el POST real hacia el endpoint de
 * EpistechWebHook configurado. Manda el mismo array de alertas tal cual
 * (mismo formato `IAlertHelix` que ya recibe ms-helix-tcp) -- Epistech
 * hoy solo lo guarda crudo, así que no hace falta transformarlo; el día
 * que su lado sepa interpretar el payload, ya le está llegando completo.
 *
 * Token opcional: EpistechWebHook trae un middleware de JWT (`jwtAuth.ts`)
 * ya escrito pero no montado en la ruta de recepción todavía -- se manda
 * igual si está configurado, para no tener que tocar este worker de nuevo
 * el día que lo activen del otro lado.
 */

const CONCURRENCY = parseInt(process.env.EPISTECH_WEBHOOK_CONCURRENCY || "2", 10);
const TIMEOUT_MS = parseInt(process.env.EPISTECH_WEBHOOK_TIMEOUT_MS || "5000", 10);

export const epistechWebhookWorker = new Worker(
  EPISTECH_WEBHOOK_QUEUE_NAME,
  async (job: Job<IAlertHelix[]>) => {
    const url = process.env.EPISTECH_WEBHOOK_URL;
    if (!url) {
      await job.log("EPISTECH_WEBHOOK_URL no configurado -- se descarta.");
      log.warn("epistech_webhook.not_configured", {});
      return { skipped: true, reason: "url_not_configured" };
    }

    const alerts = job.data;
    await job.log(`Enviando ${alerts.length} alertas a Epistech (${url}).`);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = process.env.EPISTECH_WEBHOOK_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const response = await axios.post(url, alerts, { headers, timeout: TIMEOUT_MS });

    await job.log(`Epistech respondió ${response.status}.`);
    log.info("epistech_webhook.sent", {
      count: alerts.length,
      status: response.status,
      alertIds: alerts.map((a) => a.alertId),
    });

    return { sent: alerts.length, status: response.status };
  },
  { connection: redisConnection, concurrency: CONCURRENCY },
);

epistechWebhookWorker.on("failed", (job, err) => {
  log.error("epistech_webhook.job_failed", { jobId: job?.id, message: err?.message });
});

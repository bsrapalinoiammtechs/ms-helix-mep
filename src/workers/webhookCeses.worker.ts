import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { WEBHOOK_CESES_QUEUE_NAME } from "../queues/webhookCeses.queue";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";
import { updateAlertResolved } from "../services/MongoDBService";
import { log } from "../utils/logger";

/**
 * Consume `meraki-webhook-ceses`: marca como resuelta una alerta que YA
 * existe como activa en nuestra base (`updateAlertResolved`, la misma
 * función que usa `cese.alerts.service.ts` por polling). No repite
 * validación de catálogo ni GLPI -- eso ya se hizo cuando la alerta entró
 * como activa.
 *
 * *** Caso no cubierto todavía (a propósito, para ir avanzando primero) ***
 * Si llega un cese para un `alertId` que nunca procesamos como activa (no
 * existe en Mongo), hoy simplemente se descarta con un log -- no se
 * reconstruye la alerta completa desde cero como sí hace
 * `cese.alerts.service.ts` para ese mismo caso vía polling. Evaluar si
 * hace falta una vez se vea el volumen real de este escenario.
 */

const CONCURRENCY = parseInt(process.env.WEBHOOK_CESES_CONCURRENCY || "3", 10);

export const webhookCesesWorker = new Worker(
  WEBHOOK_CESES_QUEUE_NAME,
  async (job: Job<MerakiWebhookAlertPayload>) => {
    const raw = job.data;
    await job.log(
      `Webhook de cese recibido: alertId=${raw.alertId} networkId=${raw.networkId}`,
    );

    const configuredOrgId = process.env.ORGANIZATION_ID || "";
    if (configuredOrgId && raw.organizationId && raw.organizationId !== configuredOrgId) {
      const msg = `organizationId del payload (${raw.organizationId}) no coincide con ORGANIZATION_ID configurado (${configuredOrgId}) -- se descarta por seguridad.`;
      await job.log(msg);
      log.warn("webhook_ceses.org_mismatch", {
        payload_org: raw.organizationId,
        configured_org: configuredOrgId,
        alertId: raw.alertId,
      });
      return { skipped: true, reason: "organization_mismatch" };
    }

    const alertId = raw.alertId ?? "";
    if (!alertId) {
      await job.log("Payload sin alertId -- se descarta.");
      return { skipped: true, reason: "missing_alert_id" };
    }

    // TODO: confirmar el campo real que trae la fecha de resolución en el
    // payload del webhook -- por ahora se asume `occurredAt` (el momento
    // del evento), igual criterio que para las activas.
    const resolvedAt = raw.occurredAt ?? raw.sentAt ?? new Date().toISOString();

    try {
      await updateAlertResolved(alertId, resolvedAt);
      await job.log(`Alerta ${alertId} marcada como resuelta (resolvedAt=${resolvedAt}).`);
      log.info("webhook_ceses.processed", { alertId, resolvedAt });
      return { updated: true, alertId };
    } catch (err: any) {
      // `updateAlertResolved` lanza error si no encuentra la alerta como
      // activa -- caso esperable si el cese llega para algo que nunca
      // procesamos como activa (ver nota arriba).
      await job.log(`No se encontró alerta activa con alertId=${alertId} -- se descarta. (${err?.message})`);
      log.warn("webhook_ceses.not_found", { alertId, message: err?.message });
      return { skipped: true, reason: "not_found" };
    }
  },
  { connection: redisConnection, concurrency: CONCURRENCY },
);

webhookCesesWorker.on("failed", (job, err) => {
  log.error("webhook_ceses.job_failed", { jobId: job?.id, message: err?.message });
});

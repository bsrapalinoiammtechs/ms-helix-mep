import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { WEBHOOK_ALERTS_QUEUE_NAME } from "../queues/webhookAlerts.queue";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";
import { mapMerakiWebhookAlert } from "../functions/mapMerakiWebhookAlert";
import CatalogService from "../services/catalog.service";
import ActiveAlertsService from "../services/active.alerts.service";
import { saveAlert, handleReactivation } from "../services/MongoDBService";
import { IAlert } from "../interfaces/IAlert";
import { log } from "../utils/logger";

/**
 * Consume `meraki-webhook-alerts`: valida contra el catálogo (mismo
 * `CatalogService` que usa el flujo de polling), valida el dispositivo en
 * GLPI, y guarda con `saveAlert` -- exactamente el mismo flujo final que ya
 * usa `active.alerts.service.ts`, solo que disparado por push en vez de por
 * polling. No se duplica la lógica de validación GLPI: se reutiliza el
 * método ya existente en `ActiveAlertsService`.
 *
 * Concurrency baja a propósito (no hay rate-limit de Meraki que respetar
 * acá, pero sí llamadas a GLPI de por medio) -- ajustable por env si el
 * volumen real de webhooks lo requiere.
 */

const CONCURRENCY = parseInt(process.env.WEBHOOK_ALERTS_CONCURRENCY || "3", 10);

// Instancia reutilizada solo por su método de validación GLPI -- no arranca
// ningún cron ni fetch de Meraki por sí sola.
const glpiValidator = new ActiveAlertsService();

export const webhookAlertsWorker = new Worker(
  WEBHOOK_ALERTS_QUEUE_NAME,
  async (job: Job<MerakiWebhookAlertPayload>) => {
    const raw = job.data;
    await job.log(
      `Webhook recibido: alertId=${raw.alertId} alertType=${raw.alertType} networkId=${raw.networkId}`,
    );

    // Seguridad: cada contenedor de organización tiene su propio
    // ORGANIZATION_ID configurado -- si el payload trae un organizationId
    // distinto, algo está mal ruteado (webhook mal asignado, receptor
    // compartido por error, etc.) y NO se guarda para no mezclar datos
    // entre organizaciones.
    const configuredOrgId = process.env.ORGANIZATION_ID || "";
    if (configuredOrgId && raw.organizationId && raw.organizationId !== configuredOrgId) {
      const msg = `organizationId del payload (${raw.organizationId}) no coincide con ORGANIZATION_ID configurado (${configuredOrgId}) -- se descarta por seguridad.`;
      await job.log(msg);
      log.warn("webhook_alerts.org_mismatch", {
        payload_org: raw.organizationId,
        configured_org: configuredOrgId,
        alertId: raw.alertId,
      });
      return { skipped: true, reason: "organization_mismatch" };
    }

    const alertCisco = mapMerakiWebhookAlert(raw);

    const productType = alertCisco.scope?.devices?.[0]?.productType ?? "";
    const inCatalog = await CatalogService.hasRule(alertCisco.type, productType);
    if (!inCatalog) {
      await job.log(
        `No está en catálogo (type=${alertCisco.type}, productType=${productType}) -- se descarta.`,
      );
      return { skipped: true, reason: "not_in_catalog" };
    }

    const deviceName = alertCisco.scope.devices[0]?.name ?? "";
    const glpiValidation = await glpiValidator.validateDeviceNameInGlpi(deviceName);
    await job.log(`Validación GLPI: isGlpi=${glpiValidation.isGlpi}`);

    const organizationId = raw.organizationId || configuredOrgId;
    const organizationName = raw.organizationName || process.env.ORGANIZATION_NAME || "";

    const alertToSave: IAlert = {
      alertId: alertCisco.id,
      organization: { id: organizationId, name: organizationName },
      categoryType: alertCisco.categoryType,
      network: alertCisco.network,
      startedAt: alertCisco.startedAt,
      dismissedAt: alertCisco.dismissedAt,
      resolvedAt: alertCisco.resolvedAt,
      deviceType: alertCisco.deviceType,
      type: alertCisco.type,
      title: alertCisco.title,
      description: alertCisco.description || "",
      severity: alertCisco.severity,
      scope: alertCisco.scope,
      descriptionGlpi: glpiValidation.descriptionGlpi,
      isGlpi: glpiValidation.isGlpi,
      comment: glpiValidation.comment || "",
      isTcp: false,
      location: glpiValidation.location,
    };

    await saveAlert(alertToSave);
    if (alertToSave.resolvedAt === null || alertToSave.resolvedAt === undefined) {
      await handleReactivation(alertToSave.alertId, alertToSave.startedAt);
    }

    await job.log(`Guardada: alertId=${alertToSave.alertId} isGlpi=${alertToSave.isGlpi}`);
    log.info("webhook_alerts.processed", {
      alertId: alertToSave.alertId,
      isGlpi: alertToSave.isGlpi,
      networkId: alertToSave.network?.id,
    });

    return { saved: true, alertId: alertToSave.alertId };
  },
  { connection: redisConnection, concurrency: CONCURRENCY },
);

webhookAlertsWorker.on("failed", (job, err) => {
  log.error("webhook_alerts.job_failed", { jobId: job?.id, message: err?.message });
});

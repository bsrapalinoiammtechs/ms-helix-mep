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
import WebhookTest from "../models/WebhookTest";

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

    // Meraki Toolbox valida la entrega y el renderizado del template, pero
    // normalmente no representa una alerta Assurance persistida: alertId
    // llega vacío y los datos del dispositivo pueden estar ausentes. Se
    // conserva la evidencia de la prueba en una colección separada para no
    // contaminar `alerts` ni permitir que varios tests hagan upsert sobre
    // alertId="".
    if (!alertCisco.id.trim()) {
      const device = alertCisco.scope?.devices?.[0];
      const missingFields = [
        ["alertId", alertCisco.id],
        ["deviceName", device?.name],
        ["deviceSerial", device?.serial],
        ["deviceMac", device?.mac],
      ]
        .filter(([, value]) => !String(value ?? "").trim())
        .map(([field]) => field);

      const test = await WebhookTest.create({
        source: "meraki_toolbox",
        queueJobId: String(job.id ?? ""),
        organizationId: raw.organizationId ?? configuredOrgId,
        organizationName: raw.organizationName ?? process.env.ORGANIZATION_NAME ?? "",
        networkId: alertCisco.network?.id ?? "",
        networkName: alertCisco.network?.name ?? "",
        alertType: alertCisco.type,
        productType,
        categoryType: alertCisco.categoryType,
        title: alertCisco.title,
        startedAt: alertCisco.startedAt,
        catalogMatched: inCatalog,
        payloadComplete: missingFields.length === 0,
        missingFields,
        result: inCatalog ? "catalog_matched" : "not_in_catalog",
      });

      await job.log(
        `Prueba Toolbox registrada: testId=${test._id} catalogMatched=${inCatalog} missingFields=${missingFields.join(",") || "none"}`,
      );
      log.info("webhook_alerts.toolbox_test", {
        testId: test._id,
        networkId: alertCisco.network?.id,
        type: alertCisco.type,
        productType,
        catalogMatched: inCatalog,
        missingFields,
      });

      return {
        test: true,
        saved: true,
        testId: String(test._id),
        catalogMatched: inCatalog,
        payloadComplete: missingFields.length === 0,
        missingFields,
        reason: "toolbox_test_missing_alert_id",
      };
    }

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

import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import {
  WEBHOOK_ALERTS_QUEUE_NAME,
  VERIFY_NETWORK_JOB_NAME,
  VERIFY_RESOLUTION_JOB_NAME,
  VerifyNetworkJobData,
  scheduleResolutionRetry,
} from "../queues/webhookAlerts.queue";
import { fetchMerakiPage } from "../queues/meraki.queue";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";
import { mapMerakiWebhookAlert } from "../functions/mapMerakiWebhookAlert";
import CatalogService from "../services/catalog.service";
import ActiveAlertsService from "../services/active.alerts.service";
import {
  saveAlert,
  handleReactivation,
  updateAlertResolved,
  getActiveAlertIdsByNetwork,
} from "../services/MongoDBService";
import { IAlert } from "../interfaces/IAlert";
import { log } from "../utils/logger";
import WebhookTest from "../models/WebhookTest";
import WebhookTypeStat from "../models/WebhookTypeStat";

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

// Ventana en la que varios avisos de la misma red comparten una sola consulta
// a la API: cuando 10 APs de una sede caen juntos llegan 10 webhooks, pero
// basta una consulta de alertas activas de esa red para traerlos todos.
const VERIFY_COALESCE_S = Math.ceil(
  parseInt(process.env.WEBHOOK_VERIFY_COALESCE_MS || String(5 * 60 * 1000), 10) / 1000,
);

/**
 * Pasado el umbral desde un `stopped_reporting`, pide a Meraki las alertas
 * activas de esa red (una sola llamada, por el gateway con rate-limit de
 * meraki.queue.ts -- nunca directo, para no sumar 429) y guarda las que ya
 * levantó Assurance con el mismo flujo del polling. Si era un parpadeo, la
 * API no devuelve nada y no se guarda nada.
 */
async function processNetworkVerification(job: Job<VerifyNetworkJobData>) {
  const { networkId, networkName, eventAt } = job.data;
  const orgId = process.env.ORGANIZATION_ID || job.data.organizationId;
  const lockKey = `webhook_verify:lock:${networkId}`;

  const acquired = await redisConnection.set(lockKey, "1", "EX", VERIFY_COALESCE_S, "NX");
  if (!acquired) {
    await job.log(`Red ${networkId} ya verificada hace menos de ${VERIFY_COALESCE_S}s -- se agrupa con esa consulta.`);
    return { skipped: true, reason: "recently_verified" };
  }

  try {
    const result = await fetchMerakiPage(
      {
        url: `https://api.meraki.com/api/v1/organizations/${orgId}/assurance/alerts`,
        method: "GET",
        params: { networkId, active: true, perPage: 100 },
      },
      "webhook-verify",
    );
    if (!result || result.status !== 200) {
      // Se libera el candado para que el reintento de BullMQ sí consulte.
      throw new Error(`Meraki no respondió 200 (status=${result?.status ?? "sin respuesta"})`);
    }

    const alerts = Array.isArray(result.data) ? result.data : [];
    const summary = await glpiValidator.ingestActiveAlerts(alerts);
    await job.log(`Verificación de ${networkName || networkId} (aviso ${eventAt}): ${JSON.stringify(summary)}`);
    log.info("webhook_verify.processed", { networkId, eventAt, ...summary });
    return { verified: true, ...summary };
  } catch (err) {
    await redisConnection.del(lockKey);
    throw err;
  }
}

// El candado de cese es más corto que su retraso (3 min por defecto): así dos
// recuperaciones separadas por más de esa ventana sí consultan cada una.
const RESOLUTION_COALESCE_S = Math.ceil(
  parseInt(process.env.WEBHOOK_VERIFY_CESE_COALESCE_MS || String(60 * 1000), 10) / 1000,
);
const MAX_RESOLUTION_RETRIES = 1;

/**
 * Pasados unos minutos desde un `started_reporting`, cierra las alertas de esa
 * red que Meraki ya marcó resueltas. Mismo cierre que el polling de ceses
 * (`updateAlertResolved`, que deja la alerta pendiente de envío), pero la
 * consulta es una sola por red y solo si en Mongo hay algo abierto: la
 * mayoría de las recuperaciones son parpadeos que nunca generaron alerta, y
 * esas no tocan la API de Meraki.
 */
async function processNetworkResolution(job: Job<VerifyNetworkJobData>) {
  const { networkId, networkName, eventAt } = job.data;
  const retry = job.data.retry ?? 0;
  const orgId = process.env.ORGANIZATION_ID || job.data.organizationId;

  const openIds = await getActiveAlertIdsByNetwork(networkId);
  if (openIds.length === 0) {
    await job.log(`Red ${networkId} sin alertas abiertas -- no se consulta a Meraki.`);
    return { skipped: true, reason: "no_open_alerts" };
  }

  const lockKey = `webhook_verify:cese-lock:${networkId}`;
  const acquired = await redisConnection.set(lockKey, "1", "EX", RESOLUTION_COALESCE_S, "NX");
  if (!acquired) {
    await job.log(`Red ${networkId} ya consultada hace menos de ${RESOLUTION_COALESCE_S}s -- se agrupa con esa consulta.`);
    return { skipped: true, reason: "recently_verified" };
  }

  try {
    // Sin sortBy explícito a propósito: ver nota en cese.alerts.service.ts
    // (con sortBy=resolvedAt Cisco devuelve primero los resolvedAt:null).
    const result = await fetchMerakiPage(
      {
        url: `https://api.meraki.com/api/v1/organizations/${orgId}/assurance/alerts`,
        method: "GET",
        params: { networkId, active: false, resolved: true, sortOrder: "descending", perPage: 100 },
      },
      "webhook-verify-cese",
    );
    if (!result || result.status !== 200) {
      throw new Error(`Meraki no respondió 200 (status=${result?.status ?? "sin respuesta"})`);
    }

    const resolved = new Map<string, string>(
      (Array.isArray(result.data) ? result.data : [])
        .filter((a: any) => a?.id && a?.resolvedAt)
        .map((a: any) => [String(a.id), String(a.resolvedAt)] as [string, string]),
    );

    let closed = 0;
    for (const alertId of openIds) {
      const resolvedAt = resolved.get(alertId);
      if (!resolvedAt) continue;
      try {
        await updateAlertResolved(alertId, resolvedAt);
        closed++;
      } catch (err: any) {
        log.warn("webhook_verify.resolution.update_failed", { alertId, message: err?.message });
      }
    }

    // Si esta recuperación no cerró nada, puede que Assurance aún no la haya
    // marcado resuelta: se mira una vez más más tarde. Si cerró alguna, lo
    // que queda abierto son equipos que siguen caídos de verdad.
    const retryScheduled = closed === 0 && retry < MAX_RESOLUTION_RETRIES;
    if (retryScheduled) await scheduleResolutionRetry(job.data);

    const summary = {
      open: openIds.length,
      resolved_listed: resolved.size,
      closed,
      still_open: openIds.length - closed,
      retry_scheduled: retryScheduled,
    };
    await job.log(`Cese de ${networkName || networkId} (aviso ${eventAt}): ${JSON.stringify(summary)}`);
    log.info("webhook_verify.resolution", { networkId, eventAt, retry, ...summary });
    return { verified: true, ...summary };
  } catch (err) {
    await redisConnection.del(lockKey);
    throw err;
  }
}

export const webhookAlertsWorker = new Worker(
  WEBHOOK_ALERTS_QUEUE_NAME,
  async (job: Job<MerakiWebhookAlertPayload>) => {
    if (job.name === VERIFY_NETWORK_JOB_NAME) {
      return processNetworkVerification(job as unknown as Job<VerifyNetworkJobData>);
    }
    if (job.name === VERIFY_RESOLUTION_JOB_NAME) {
      return processNetworkResolution(job as unknown as Job<VerifyNetworkJobData>);
    }
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

    // Contador por tipo/producto: permite ver qué `alertType` llegan realmente
    // por webhook (incluidos los descartados por not_in_catalog) sin revisar
    // job por job en bull-board. Nunca debe romper el procesamiento.
    if (alertCisco.id.trim()) {
      try {
        const now = new Date();
        await WebhookTypeStat.updateOne(
          { alertType: alertCisco.type, productType },
          {
            $inc: { count: 1 },
            $set: {
              inCatalog,
              lastSeenAt: now,
              lastNetworkName: alertCisco.network?.name ?? "",
              lastTitle: alertCisco.title ?? "",
              lastCategoryType: alertCisco.categoryType ?? "",
            },
            $setOnInsert: { firstSeenAt: now },
          },
          { upsert: true },
        );
      } catch (err: any) {
        log.warn("webhook_alerts.type_stat_error", { message: err?.message });
      }
    }

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

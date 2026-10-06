import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import {
  WEBHOOK_ALERTS_QUEUE_NAME,
  VERIFY_NETWORK_JOB_NAME,
  VERIFY_RESOLUTION_JOB_NAME,
  SWEEP_RESOLUTIONS_JOB_NAME,
  SWEEP_ACTIVE_JOB_NAME,
  RECENT_NETWORKS_KEY,
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
  getOpenAlertsForSweep,
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

const SWEEP_MAX_PAGES = parseInt(process.env.WEBHOOK_VERIFY_SWEEP_MAX_PAGES || "3", 10);
// Hasta cuántas horas hacia atrás cuenta un `stopped_reporting` para que el
// barrido guarde alertas ya resueltas de esa red.
const SWEEP_LOOKBACK_MS = parseInt(
  process.env.WEBHOOK_VERIFY_SWEEP_LOOKBACK_MS || String(3 * 60 * 60 * 1000),
  10,
);

// Tope de antigüedad hacia atrás de un barrido, sin importar qué tan vieja sea
// la alerta abierta más antigua.
const SWEEP_MAX_AGE_MS = parseInt(
  process.env.WEBHOOK_VERIFY_SWEEP_MAX_AGE_MS || String(24 * 60 * 60 * 1000),
  10,
);

function nextPageUrl(headers: Record<string, any> | undefined): string | null {
  const match = String(headers?.["link"] || "").match(/<([^>]+)>;\s*rel=next/);
  return match?.[1] ?? null;
}

/**
 * Respaldo de `processNetworkVerification` y `processNetworkResolution`: no
 * depende de ningún aviso puntual. Lee UNA lista de alertas RESUELTAS de la
 * organización (ordenada por resolvedAt descendente; pagina más solo si hace
 * falta, hasta SWEEP_MAX_PAGES) y con ella hace dos cosas:
 *
 * 1. Cierra las alertas abiertas de Mongo que Meraki ya resolvió.
 * 2. Guarda las resueltas que NUNCA se guardaron -- una caída que duró lo
 *    bastante para que Assurance la levantara pero cesó antes de la
 *    verificación (visto 5-oct-2026: caídas de 22-24 min que producción
 *    registró y -wh no). Solo de redes con un `stopped_reporting` reciente,
 *    para que siga siendo una reacción al webhook y no un polling de toda la
 *    organización.
 *
 * Sin abiertas ni redes recientes no toca la API. Lo resuelto hace más de lo
 * que alcanzan las páginas se limpia con la conciliación existente.
 */
async function processResolutionSweep(job: Job) {
  const now = Date.now();
  await redisConnection.zremrangebyscore(RECENT_NETWORKS_KEY, "-inf", now - SWEEP_LOOKBACK_MS);
  const recentNetworks = new Set(await redisConnection.zrange(RECENT_NETWORKS_KEY, 0, -1));
  const open = await getOpenAlertsForSweep();

  if (open.length === 0 && recentNetworks.size === 0) {
    await job.log("Sin alertas abiertas ni redes recientes -- no se consulta a Meraki.");
    return { skipped: true, reason: "nothing_to_sweep" };
  }

  const orgId = process.env.ORGANIZATION_ID || "";
  const pending = new Set(open.map((a) => a.alertId));
  const openStarts = open.map((a) => Date.parse(a.startedAt)).filter((t) => !Number.isNaN(t));
  const oldestOpenMs = openStarts.length ? Math.min(...openStarts) : Infinity;

  let url: string | null = `https://api.meraki.com/api/v1/organizations/${orgId}/assurance/alerts`;
  let params: Record<string, any> | undefined = {
    active: false,
    resolved: true,
    sortOrder: "descending",
    perPage: 300,
  };
  let pages = 0;
  let listed = 0;
  let closed = 0;
  let floorMs = oldestOpenMs;
  const ingested = { candidates: 0, already_known: 0, not_in_catalog: 0, saved: 0 };

  while (url && pages < SWEEP_MAX_PAGES) {
    const result = await fetchMerakiPage({ url, method: "GET", params }, "webhook-sweep-cese");
    if (!result || result.status !== 200) {
      throw new Error(`Meraki no respondió 200 (status=${result?.status ?? "sin respuesta"})`);
    }
    pages++;
    const page: any[] = Array.isArray(result.data) ? result.data : [];
    listed += page.length;

    // El piso de fecha se toma de la resuelta más reciente que devuelve
    // Meraki (no de este servidor, cuyo reloj va adelantado): hasta ahí hacia
    // atrás cuentan las redes recientes.
    if (pages === 1) {
      const newestMs = Date.parse(page[0]?.resolvedAt ?? "");
      if (!Number.isNaN(newestMs)) {
        if (recentNetworks.size > 0) floorMs = Math.min(floorMs, newestMs - SWEEP_LOOKBACK_MS);
        // Una alerta abierta muy vieja (ej. de pruebas, abierta desde hace
        // semanas) no debe obligar a paginar todo el historial en cada
        // barrido: nunca se baja de SWEEP_MAX_AGE_MS. Lo más antiguo lo
        // limpia la conciliación existente.
        floorMs = Math.max(floorMs, newestMs - SWEEP_MAX_AGE_MS);
      }
    }

    for (const a of page) {
      if (!a?.id || !a?.resolvedAt || !pending.has(String(a.id))) continue;
      try {
        await updateAlertResolved(String(a.id), String(a.resolvedAt));
        pending.delete(String(a.id));
        closed++;
      } catch (err: any) {
        log.warn("webhook_verify.sweep.update_failed", { alertId: a.id, message: err?.message });
      }
    }

    const ofRecentNetworks = page.filter((a) => a?.resolvedAt && recentNetworks.has(a.network?.id));
    if (ofRecentNetworks.length > 0) {
      const r = await glpiValidator.ingestResolvedAlerts(ofRecentNetworks);
      ingested.candidates += r.seen;
      ingested.already_known += r.already_known;
      ingested.not_in_catalog += r.not_in_catalog;
      ingested.saved += r.saved;
    }

    // Las páginas vienen de la más reciente a la más antigua: si la última
    // resuelta de esta página es anterior al piso, más atrás no hay nada
    // que nos interese.
    const lastResolvedMs = Date.parse(page[page.length - 1]?.resolvedAt ?? "");
    if (page.length === 0 || (!Number.isNaN(lastResolvedMs) && lastResolvedMs < floorMs)) break;
    if (pending.size === 0 && recentNetworks.size === 0) break;

    url = nextPageUrl(result.headers);
    params = undefined; // el Link de la siguiente página ya trae los parámetros
  }

  const summary = {
    open: open.length,
    recent_networks: recentNetworks.size,
    pages,
    listed,
    closed,
    still_open: pending.size,
    ingested_resolved: ingested,
  };
  await job.log(`Barrido de ceses: ${JSON.stringify(summary)}`);
  log.info("webhook_verify.sweep", summary);
  return { swept: true, ...summary };
}

const ACTIVE_SWEEP_MAX_PAGES = parseInt(process.env.WEBHOOK_VERIFY_ACTIVE_SWEEP_MAX_PAGES || "5", 10);
const ACTIVE_SWEEP_TYPES = (process.env.WEBHOOK_VERIFY_ACTIVE_SWEEP_TYPES || "unreachable")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * Lista las alertas ACTIVAS de la organización de los tipos configurados
 * (por defecto solo `unreachable`) y guarda las que Mongo no conoce, con el
 * mismo flujo de `ingestActiveAlerts` (redes de estacionamiento, catálogo,
 * GLPI). Es la garantía de cobertura del webhook: el aviso acelera la
 * detección, este barrido evita que un corte sin aviso quede invisible.
 */
async function processActiveSweep(job: Job) {
  const orgId = process.env.ORGANIZATION_ID || "";
  let url: string | null = `https://api.meraki.com/api/v1/organizations/${orgId}/assurance/alerts`;
  let params: Record<string, any> | undefined = {
    active: true,
    types: ACTIVE_SWEEP_TYPES,
    perPage: 300,
  };
  let pages = 0;
  let listed = 0;
  const total = { seen: 0, stale_network_skipped: 0, already_known: 0, not_in_catalog: 0, saved: 0 };

  while (url && pages < ACTIVE_SWEEP_MAX_PAGES) {
    const result = await fetchMerakiPage({ url, method: "GET", params }, "webhook-sweep-active");
    if (!result || result.status !== 200) {
      throw new Error(`Meraki no respondió 200 (status=${result?.status ?? "sin respuesta"})`);
    }
    pages++;
    const page: any[] = Array.isArray(result.data) ? result.data : [];
    listed += page.length;
    if (page.length > 0) {
      const r = await glpiValidator.ingestActiveAlerts(page);
      total.seen += r.seen;
      total.stale_network_skipped += r.stale_network_skipped;
      total.already_known += r.already_known;
      total.not_in_catalog += r.not_in_catalog;
      total.saved += r.saved;
    }
    url = nextPageUrl(result.headers);
    params = undefined;
  }

  const summary = { types: ACTIVE_SWEEP_TYPES, pages, listed, truncated: !!url, ...total };
  await job.log(`Barrido de activas: ${JSON.stringify(summary)}`);
  log.info("webhook_verify.active_sweep", summary);
  return { swept: true, ...summary };
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
    if (job.name === SWEEP_RESOLUTIONS_JOB_NAME) {
      return processResolutionSweep(job);
    }
    if (job.name === SWEEP_ACTIVE_JOB_NAME) {
      return processActiveSweep(job);
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

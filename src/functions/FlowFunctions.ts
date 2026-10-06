import { Job } from "bullmq";
import { IAlert } from "../interfaces/IAlert";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import {
  getListOfActiveAlerts,
  getListOfResolvedAlerts,
} from "../services/CiscoMerakiAPIService";
import {
  getPendingAlertsForSend,
  saveAlert,
  setIsTCpAlert,
  updateAlertResolved,
  getAlertsInGlpi,
} from "../services/MongoDBService";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import {
  getNetworkData,
  getNetworkId,
  getSessionToken,
} from "../services/GlpiAPIService";
import { INetworkGlpi } from "../interfaces/INetworkGlpiResponse";
import { DescriptionEnum } from "../enums/DescriptionEnum";
import { IAlertHelix } from "../interfaces/IAlertHelix";
import { FieldEnum } from "../enums/FieldEnum";
import { AlertSeverityHelixEnum } from "../enums/AlertSeverityEnum";
import { sendAlertsToTcp } from "../services/TcpApiService";
import { parseAlertTypes } from "../services/cisco.alerts.service";
import { enqueueEpistechAlerts } from "../queues/epistechWebhook.queue";
import CatalogService from "../services/catalog.service";
import { log } from "../utils/logger";
import lodash from "lodash";

export const getAndSaveActiveAlerts = async () => {
  const organizationId: string = process.env.ORGANIZATION_ID || "";
  const organizationName: string = process.env.ORGANIZATION_NAME || "";
  try {
    console.log("SAA: Obteniendo alertas activas para procesar su guardado: ", new Date(Date.now()).toLocaleString('es-CO'));
    const ciscoAlerts: IAlertCisco[] = await getListOfActiveAlerts();
    console.log("SAA: Cantidad de alertas cisco para procesar: ", ciscoAlerts?.length);
    type IAlertCiscoGlpi = IAlertCisco & {
      descriptionGlpi: string;
      isGlpi: boolean;
      comment: string;
      location: string;
    };
    let validateAlerts: IAlertCiscoGlpi[] = [];
    let skippedNotInCatalog = 0;

    for (const alertCisco of ciscoAlerts) {
      try {
        const productType = alertCisco.scope?.devices?.[0]?.productType ?? "";
        const inCatalog = await CatalogService.hasRule(alertCisco.type, productType);
        if (!inCatalog) {
          skippedNotInCatalog++;
          continue;
        }
        const validationGlpi: {
          descriptionGlpi: string;
          isGlpi: boolean;
          comment: string;
          location: string;
        } = await validateDeviceNameInGlpi(
          lodash.defaultTo(alertCisco.scope.devices[0].name, "")
        );
        if (validationGlpi.isGlpi) {
          validateAlerts.push({
            ...alertCisco,
            descriptionGlpi: validationGlpi.descriptionGlpi,
            isGlpi: validationGlpi.isGlpi,
            comment: validationGlpi.comment,
            location: validationGlpi.location,
          });
        }
      } catch (error) {
        console.warn(
          `No se pudo validar el dispositivo: ${alertCisco.scope.devices[0].name}`,
          error
        );
      }
    }
    if (skippedNotInCatalog > 0) {
      log.info("saa.alerts.skipped.notInCatalog", {
        skipped: skippedNotInCatalog,
        received: ciscoAlerts.length,
      });
    }

    const savePromises = validateAlerts.map(
      async (alertValidate: IAlertCiscoGlpi) => {
        const alertToSave: IAlert = {
          alertId: alertValidate.id,
          organization: {
            id: organizationId,
            name: organizationName,
          },
          categoryType: alertValidate.categoryType,
          network: alertValidate.network,
          startedAt: alertValidate.startedAt,
          dismissedAt: alertValidate.dismissedAt,
          resolvedAt: alertValidate.resolvedAt,
          deviceType: alertValidate.deviceType,
          type: alertValidate.type,
          title: alertValidate.title,
          description: alertValidate.description || "",
          severity: alertValidate.severity,
          scope: alertValidate.scope,
          descriptionGlpi: alertValidate.descriptionGlpi,
          isGlpi: alertValidate.isGlpi,
          comment: alertValidate.comment || "",
          isTcp: false,
          location: alertValidate.location,
        };
        await saveAlert(alertToSave);
      }
    );

    await Promise.all(savePromises);
    console.log(`SAA: ${validateAlerts.length} alertas de cisco validas procesadas`);
  } catch (error) {
    console.log(error);
  }
};

const validateDeviceNameInGlpi = async (
  nameDevice: string
): Promise<{
  descriptionGlpi: string;
  isGlpi: boolean;
  comment: string;
  location: string;
}> => {
  try {
    const sessionToken: string = await getSessionToken();
    const networkId: { match: boolean; id: string } = await getNetworkId(
      nameDevice,
      sessionToken
    );
    if (networkId.match) {
      const networkData: INetworkGlpi = await getNetworkData(
        networkId.id,
        sessionToken
      );
      return {
        descriptionGlpi: networkData.sysdescr,
        isGlpi: true,
        comment: networkData.comment,
        location: networkData.locations_id,
      };
    } else {
      return {
        descriptionGlpi: DescriptionEnum.NO_MATCH_DEVICE_NAME,
        isGlpi: false,
        comment: "",
        location: "",
      };
    }
  } catch (error) {
    return {
      descriptionGlpi: DescriptionEnum.NO_MATCH_DEVICE_NAME,
      isGlpi: false,
      comment: DescriptionEnum.NO_MATCH_DEVICE_NAME,
      location: DescriptionEnum.NO_MATCH_DEVICE_NAME,
    };
  }
};

interface IBuiltAlert {
  payload: IAlertHelix;
  expectedResolvedAt: string | null;
}

/**
 * Silencio por tipo (respaldo): TCP_SILENT_TYPES (lista separada por comas) +
 * TCP_SILENT_FROM (ISO, hora de ESTE servidor). Las alertas de esos tipos
 * CREADAS desde TCP_SILENT_FROM se procesan y guardan normalmente, pero no se
 * envían a Helix ni a Epistech: se marcan como enviadas sin enviar. Sirve
 * para dejar el polling corriendo como respaldo de un tipo que ya llega por
 * webhook por otra instancia, sin duplicar alertas.
 *
 * La fecha de corte es obligatoria a propósito: las alertas anteriores ya
 * están en Helix, y su cese (que sale por este mismo ciclo) tiene que seguir
 * enviándose. La clasificación depende solo de (tipo, createdAt), así que el
 * cese de una alerta silenciada también queda silenciado. Sin
 * TCP_SILENT_FROM válido no se silencia nada (falla hacia enviar).
 */
function getSilentRule(): { types: string[]; fromMs: number } | null {
  const types = parseAlertTypes(process.env.TCP_SILENT_TYPES);
  if (!types) return null;
  const fromMs = Date.parse(process.env.TCP_SILENT_FROM || "");
  if (Number.isNaN(fromMs)) {
    log.error("send.silent.invalid_from", {
      message: "TCP_SILENT_TYPES definido sin TCP_SILENT_FROM válido (ISO) -- no se silencia nada",
    });
    return null;
  }
  return { types, fromMs };
}

/**
 * Silencio de CESES hacia Helix: TCP_SILENT_CESE_TYPES (lista) +
 * TCP_SILENT_CESE_BEFORE (ISO, hora de ESTE servidor). El cese de una alerta
 * de esos tipos CREADA antes de esa fecha no se envía a Helix (sí a Epistech,
 * que es idempotente por alert_id). Para la instancia -wh: las alertas
 * anteriores al corte las gestiona producción, y Helix identifica la alarma
 * por nombre de equipo, así que un cese repetido que llegue tarde podría
 * cerrar una alarma NUEVA del mismo equipo. Sin ambas variables válidas no
 * se silencia nada.
 */
function getSilentCeseRule(): { types: string[]; beforeMs: number } | null {
  const types = parseAlertTypes(process.env.TCP_SILENT_CESE_TYPES);
  if (!types) return null;
  const beforeMs = Date.parse(process.env.TCP_SILENT_CESE_BEFORE || "");
  if (Number.isNaN(beforeMs)) {
    log.error("send.silent_cese.invalid_before", {
      message: "TCP_SILENT_CESE_TYPES definido sin TCP_SILENT_CESE_BEFORE válido (ISO) -- no se silencia nada",
    });
    return null;
  }
  return { types, beforeMs };
}

/**
 * `job` es opcional -- si viene (llamado desde sendAlerts.worker.ts), cada
 * paso queda registrado en `job.log()` y visible en la pestaña Logs de
 * bull-board. A diferencia de antes, si algo falla acá el error se
 * relanza (ya no se traga silenciosamente) para que el job quede marcado
 * como `failed` en el dashboard -- el caller (el cron en index.ts, o el
 * worker de BullMQ) sigue teniendo su propio try/catch para loguearlo.
 */
export const validateAndBuildAlertsToSend = async (job?: Job) => {
  try {
    const alertsFiltered: IAlert[] = await getPendingAlertsForSend(1000);
    console.log("Cantidad de alertas pendientes: ", alertsFiltered?.length, new Date(Date.now()).toLocaleString('es-CO'));
    await job?.log(`Alertas pendientes de envío encontradas en Mongo: ${alertsFiltered?.length ?? 0}`);

    const builtAll: IBuiltAlert[] = await buildAlertsForHelix(alertsFiltered);

    // Silencio por tipo (ver getSilentRule): se marcan como enviadas sin
    // enviar, y el resto del ciclo sigue solo con `built`.
    const silentRule = getSilentRule();
    const silentIds = new Set(
      silentRule
        ? alertsFiltered
            .filter(
              (a) =>
                silentRule.types.includes(a.type) &&
                new Date((a as any).createdAt).getTime() >= silentRule.fromMs,
            )
            .map((a) => a.alertId)
        : [],
    );
    const silentBuilt = builtAll.filter((b) => silentIds.has(b.payload.alertId));
    const built: IBuiltAlert[] = builtAll.filter((b) => !silentIds.has(b.payload.alertId));
    let silenced = 0;
    if (silentBuilt.length > 0) {
      const silentClaims = await Promise.allSettled(
        silentBuilt.map(async (b) => (await setIsTCpAlert(b.payload.alertId, b.expectedResolvedAt)) !== null),
      );
      silenced = silentClaims.filter((r) => r.status === "fulfilled" && r.value).length;
      await job?.log(
        `Silenciadas (TCP_SILENT_TYPES=${process.env.TCP_SILENT_TYPES}): ${silenced} de ${silentBuilt.length} -- marcadas como enviadas sin enviar a Helix ni a Epistech.`,
      );
    }

    console.log("Alertas a enviar: ", built.length, new Date(Date.now()).toLocaleString('es-CO'));
    await job?.log(`Alertas con regla de catálogo, listas para Helix: ${built.length} de ${alertsFiltered.length} pendientes (silenciadas: ${silenced})`);

    if (built.length === 0) {
      await job?.log("Nada que enviar en este ciclo -- termina aquí");
      log.info("send.cron.summary", {
        received: alertsFiltered.length,
        built: 0,
        silenced,
        tcp_success: 0,
        tcp_failed: 0,
        claimed: 0,
        race_lost: 0,
        catalog: CatalogService.stats(),
      });
      return;
    }

    const payloads: IAlertHelix[] = built.map((b) => b.payload);

    // Ceses que NO deben ir a Helix (ver getSilentCeseRule): siguen a
    // Epistech y se marcan como enviados igual, solo se omiten del envío TCP.
    const ceseRule = getSilentCeseRule();
    const tcpSkipIds = new Set(
      ceseRule
        ? alertsFiltered
            .filter(
              (a) =>
                a.resolvedAt !== null &&
                a.resolvedAt !== undefined &&
                ceseRule.types.includes(a.type) &&
                new Date((a as any).createdAt).getTime() < ceseRule.beforeMs,
            )
            .map((a) => a.alertId)
        : [],
    );
    const tcpPayloads: IAlertHelix[] = payloads.filter((p) => !tcpSkipIds.has(p.alertId));
    const tcpSkippedCese = payloads.length - tcpPayloads.length;
    if (tcpSkippedCese > 0) {
      await job?.log(`Ceses omitidos del envío a Helix (TCP_SILENT_CESE_*): ${tcpSkippedCese}`);
    }

    // Envío a EPISTECH (mismo payload, caídas + ceses juntos) -- va ANTES
    // del envío a TCP a propósito: `sendAlertsToTcp` relanza su error si
    // ms-helix-tcp está caído, y eso corta esta función; si Epistech se
    // encolara después, una caída de TCP dejaría también a Epistech sin
    // recibir nada (los dos canales deben ser independientes).
    // Contrapartida aceptada: mientras TCP siga fallando, las alertas
    // siguen pendientes (isTcp:false) y se vuelven a encolar a Epistech en
    // cada ciclo -- es idempotente de ese lado (upsert por alert_id).
    // Encolado, no awaited -- lo procesa epistechWebhook.worker.ts. Si
    // EPISTECH_WEBHOOK_ENABLED != "true" no hace nada.
    try {
      const epistechJob = await enqueueEpistechAlerts(payloads);
      if (epistechJob) {
        await job?.log(`Encoladas ${payloads.length} alertas para Epistech (job ${epistechJob.id}).`);
      }
    } catch (error: any) {
      // No relanzar: un fallo encolando hacia Epistech no debe tumbar el
      // ciclo de envío a Helix, que es el canal principal.
      log.warn("epistech_webhook.enqueue.error", { message: error?.message });
      await job?.log(`No se pudo encolar el envío a Epistech: ${error?.message}`);
    }

    // TCP_ENABLED=false (default: true) es para instancias que solo deben
    // alimentar a Epistech y NO tocar Helix (ej. ms-helix-mep-wh): se omite
    // el envío a ms-helix-tcp y se tratan como entregadas para que se
    // marquen isTcp:true y no se reintenten cada minuto. NO activar en la
    // instancia de producción -- ahí las alertas dejarían de llegar a
    // Helix quedando marcadas como enviadas.
    const tcpEnabled = process.env.TCP_ENABLED !== "false";
    const emitAlertsToHelix: { success: number; failed: number } =
      tcpEnabled && tcpPayloads.length > 0
        ? await sendAlertsToTcp(tcpPayloads)
        : { success: tcpPayloads.length, failed: 0 };
    if (!tcpEnabled) {
      await job?.log("TCP_ENABLED=false: no se envía a ms-helix-tcp (instancia solo-Epistech).");
    }
    console.log(`Resultado del envío a TCP: ${emitAlertsToHelix.success} exitosos, ${emitAlertsToHelix.failed} fallidos`, new Date(Date.now()).toLocaleString('es-CO'));
    await job?.log(`Envío a ms-helix-tcp: ${emitAlertsToHelix.success} exitosos, ${emitAlertsToHelix.failed} fallidos`);

    let claimed = 0;
    let raceLost = 0;
    if (emitAlertsToHelix.failed === 0) {
      const claimResults = await Promise.allSettled(
        built.map(async (b) => {
          const ok = await setIsTCpAlert(b.payload.alertId, b.expectedResolvedAt);
          return ok !== null;
        })
      );
      for (const r of claimResults) {
        if (r.status === "fulfilled" && r.value) claimed++;
        else raceLost++;
      }
      await job?.log(`Marcadas como enviadas en Mongo: ${claimed}${raceLost > 0 ? ` (perdidas por condición de carrera: ${raceLost})` : ""}`);
    } else {
      await job?.log(`TCP tuvo fallos (${emitAlertsToHelix.failed}) -- no se marca nada como enviado, se reintentará en el próximo ciclo`);
      log.warn("send.cron.tcp_failed.skipping_claim", {
        failed: emitAlertsToHelix.failed,
        success: emitAlertsToHelix.success,
      });
    }

    log.info("send.cron.summary", {
      received: alertsFiltered.length,
      built: built.length,
      silenced,
      tcp_skipped_cese: tcpSkippedCese,
      tcp_success: emitAlertsToHelix.success,
      tcp_failed: emitAlertsToHelix.failed,
      claimed,
      race_lost: raceLost,
      catalog: CatalogService.stats(),
    });
  } catch (error) {
    console.log(error);
    await job?.log(`Error: ${(error as Error)?.message ?? "desconocido"}`);
    log.error("send.cron.error", { message: (error as Error)?.message });
    throw error;
  }
};

async function buildAlertsForHelix(alerts: IAlert[]): Promise<IBuiltAlert[]> {
  const tipo: string = process.env.TIPO_ALERTA || FieldEnum.TIPO;
  const fase: string = process.env.FASE_ALERTA || FieldEnum.FASE;

  const built: IBuiltAlert[] = [];
  let alertNotSentCount = 0;
  let skippedNotInCatalog = 0;
  for (const alert of alerts) {
    try {
      const rule = await CatalogService.getRule(
        alert.type,
        alert.scope.devices[0].productType
      );

      if (rule) {
        const isCese = !lodash.isNull(alert.resolvedAt);
        built.push({
          expectedResolvedAt: alert.resolvedAt ?? null,
          payload: {
            tipo: tipo,
            idNotificacion: alert.alertId,
            fechaHora: isCese
              ? formatDateString(alert.resolvedAt!)
              : formatDateString(alert.startedAt),
            nombreEquipo: alert.scope.devices[0].name,
            ipEquipo: alert.scope.devices[0].mac,
            causaEvento: rule.categoryType,
            evento: rule.title,
            severidadEvento: isCese
              ? AlertSeverityHelixEnum.CESE
              : (rule.severityHelix as AlertSeverityHelixEnum),
            descripcionEvento: `${rule.elementType} - ${rule.categoryType} - ${alert.comment}`,
            nombreCliente: alert.organization.name,
            ubicacion: alert.location,
            fase: fase,
            alertId: alert.alertId,
            organization: alert.organization,
          },
        });
      } else {
        skippedNotInCatalog++;
      }
    } catch (error) {
      alertNotSentCount = alertNotSentCount + 1;
      console.error(
        `Error al validar la alerta ${alert.alertId} para envío manual, no se enviará a Helix`,
        error
      );
    }
  }
  if (skippedNotInCatalog > 0) {
    log.info("send.cron.skipped.notInCatalog", {
      skipped: skippedNotInCatalog,
      total: alerts.length,
      sent: built.length,
    });
  }
  console.log(
    `Total alertas a enviar: ${built.length}. No enviadas por error: ${alertNotSentCount}. Sin catálogo: ${skippedNotInCatalog}`,
    new Date(Date.now()).toLocaleString("es-CO")
  );
  return built;
}

function formatDateString(dateString: string): string {
  const timeZone = "America/Costa_Rica";
  const date = new Date(dateString);
  const zonedDate = toZonedTime(date, timeZone);
  return format(zonedDate, "dd-MM-yyyy HH:mm:ss");
}

export const getAndSetResolvedAlerts = async () => {
  try {
    console.log("SRA: Obteniendo alertas resueltas para procesar su actualización: ", new Date(Date.now()).toLocaleString('es-CO'));
    const resolvedAlerts: IAlertCisco[] = await getListOfResolvedAlerts();
    const activeAlerts: IAlert[] = await getAlertsInGlpi();
    console.log("resolvedAlerts[0]: ", resolvedAlerts[0])
    const activeAlertsMap = new Map(
      activeAlerts.map((alert) => [alert.alertId, alert])
    );

    const alertsToUpdate: { alertId: string; resolvedAt: string }[] =
      resolvedAlerts
        .filter(
          (resolved) => activeAlertsMap.has(resolved.id) && resolved.resolvedAt
        )
        .map((resolved) => {
          return {
            alertId: resolved.id,
            resolvedAt: resolved.resolvedAt!,
          };
        });

    const updatedPromises = alertsToUpdate.map(
      async (alertToUpdate: { alertId: string; resolvedAt: string }) => {
        try {
          console.log("updatedPromises: ", alertToUpdate.alertId);
          await updateAlertResolved(
            alertToUpdate.alertId,
            alertToUpdate.resolvedAt
          );
        } catch (error) {
          console.error(
            `Error al actualizar la alerta ${alertToUpdate.alertId}`,
            error
          );
        }
      }
    );


    await Promise.allSettled(updatedPromises);
    console.log(`SRA: Se resolvieron: ${alertsToUpdate.length} alertas`);
  } catch (error) {
    console.log(error);
  }
};

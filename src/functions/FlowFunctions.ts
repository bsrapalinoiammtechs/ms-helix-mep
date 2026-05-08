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

export const validateAndBuildAlertsToSend = async () => {
  try {
    const alertsFiltered: IAlert[] = await getPendingAlertsForSend(1000);
    console.log("Cantidad de alertas pendientes: ", alertsFiltered?.length, new Date(Date.now()).toLocaleString('es-CO'));

    const built: IBuiltAlert[] = await buildAlertsForHelix(alertsFiltered);
    console.log("Alertas a enviar: ", built.length, new Date(Date.now()).toLocaleString('es-CO'));

    if (built.length === 0) {
      log.info("send.cron.summary", {
        received: alertsFiltered.length,
        built: 0,
        tcp_success: 0,
        tcp_failed: 0,
        claimed: 0,
        race_lost: 0,
        catalog: CatalogService.stats(),
      });
      return;
    }

    const payloads: IAlertHelix[] = built.map((b) => b.payload);
    const emitAlertsToHelix: { success: number; failed: number } =
      await sendAlertsToTcp(payloads);
    console.log(`Resultado del envío a TCP: ${emitAlertsToHelix.success} exitosos, ${emitAlertsToHelix.failed} fallidos`, new Date(Date.now()).toLocaleString('es-CO'));

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
    } else {
      log.warn("send.cron.tcp_failed.skipping_claim", {
        failed: emitAlertsToHelix.failed,
        success: emitAlertsToHelix.success,
      });
    }

    log.info("send.cron.summary", {
      received: alertsFiltered.length,
      built: built.length,
      tcp_success: emitAlertsToHelix.success,
      tcp_failed: emitAlertsToHelix.failed,
      claimed,
      race_lost: raceLost,
      catalog: CatalogService.stats(),
    });
  } catch (error) {
    console.log(error);
    log.error("send.cron.error", { message: (error as Error)?.message });
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

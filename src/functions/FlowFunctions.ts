import { IAlert } from "../interfaces/IAlert";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import {
  getListOfActiveAlerts,
  getListOfResolvedAlerts,
} from "../services/CiscoMerakiAPIService";
import {
  getAlarmsManual,
  getAlertsInGlpi,
  saveAlert,
  updateAlertResolved,
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
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import lodash from "lodash";
import { sendAlertsToTcp } from "../services/TcpApiService";

export const getAndSaveActiveAlerts = async () => {
  const organizationId: string = process.env.ORGANIZATION_ID || "";
  const organizationName: string = process.env.ORGANIZATION_NAME || "";
  try {
    const ciscoAlerts: IAlertCisco[] = await getListOfActiveAlerts();

    type IAlertCiscoGlpi = IAlertCisco & {
      descriptionGlpi: string;
      isGlpi: boolean;
      comment: string;
    };
    let validateAlerts: IAlertCiscoGlpi[] = [];

    for (const alertCisco of ciscoAlerts) {
      try {
        const validationGlpi: {
          descriptionGlpi: string;
          isGlpi: boolean;
          comment: string;
        } = await validateDeviceNameInGlpi(
          lodash.defaultTo(alertCisco.scope.devices[0].name, "")
        );
        if (validationGlpi.isGlpi) {
          validateAlerts.push({
            ...alertCisco,
            descriptionGlpi: validationGlpi.descriptionGlpi,
            isGlpi: validationGlpi.isGlpi,
            comment: validationGlpi.comment,
          });
        }
      } catch (error) {
        console.warn(
          `No se pudo validar el dispositivo: ${alertCisco.scope.devices[0].name}`,
          error
        );
      }
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
        };
        await saveAlert(alertToSave);
      }
    );

    await Promise.all(savePromises);
    console.log(`${validateAlerts.length} alertas de cisco validas procesadas`);
  } catch (error) {
    console.log(error);
  }
};

const validateDeviceNameInGlpi = async (
  nameDevice: string
): Promise<{ descriptionGlpi: string; isGlpi: boolean; comment: string }> => {
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
      };
    } else {
      return {
        descriptionGlpi: DescriptionEnum.NO_MATCH_DEVICE_NAME,
        isGlpi: false,
        comment: "",
      };
    }
  } catch (error) {
    return {
      descriptionGlpi: DescriptionEnum.NO_MATCH_DEVICE_NAME,
      isGlpi: false,
      comment: DescriptionEnum.NO_MATCH_DEVICE_NAME,
    };
  }
};

export const validateAndBuildAlertsToSend = async () => {
  try {
    const alerts: IAlert[] = await getAlertsInGlpi();
    const alertsToSend: IAlertHelix[] = await validateAlarmManual(alerts);
    const emitAlertsToHelix: { success: number; failed: number } =
      await sendAlertsToTcp(alertsToSend);
    console.log(
      `${emitAlertsToHelix.success} alertas emitidas satisfactorias y ${emitAlertsToHelix.failed} fallidas al servidor TCP`
    );
  } catch (error) {
    console.log(error);
  }
};

async function validateAlarmManual(alerts: IAlert[]) {
  const tipo: string = process.env.TIPO_ALERTA || FieldEnum.TIPO;
  const fase: string = process.env.FASE_ALERTA || FieldEnum.FASE;

  let alertsToSend: IAlertHelix[] = [];

  for (const alert of alerts) {
    try {
      const alarmManual = await getAlarmsManual(
        alert.type,
        alert.scope.devices[0].productType
      );

      if (alarmManual.length > 0) {
        alertsToSend.push({
          tipo: tipo,
          idNotificacion: alert.scope.devices[0].url,
          fechaHora: formatDateString(alert.startedAt),
          nombreEquipo: alert.scope.devices[0].name,
          ipEquipo: alert.scope.devices[0].mac,
          causaEvento: alarmManual[0].categoryType,
          evento: alarmManual[0].title,
          severidadEvento: !lodash.isNull(alert.resolvedAt)
            ? AlertSeverityHelixEnum.CESE
            : alarmManual[0].severityHelix,
          descripcionEvento: `${alarmManual[0].elementType} - ${alarmManual[0].categoryType} - ${alert.comment}`,
          nombreCliente: alert.organization.name,
          ubicacion: alert.network.name,
          fase: fase,
          alertId: alert.alertId,
          organization: alert.organization,
        });
      }
    } catch (error) {
      throw handleError(ErrorCode.E012, alert.alertId);
    }
  }
  return alertsToSend;
}

function formatDateString(dateString: string): string {
  const timeZone = "America/Costa_Rica";
  const date = new Date(dateString);
  const zonedDate = toZonedTime(date, timeZone);
  return format(zonedDate, "dd-MM-yyyy HH:mm:ss");
}

export const getAndSetResolvedAlerts = async () => {
  try {
    const resolvedAlerts: IAlertCisco[] = await getListOfResolvedAlerts();
    const activeAlerts: IAlert[] = await getAlertsInGlpi();

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
    console.log(`Se resolvieron: ${alertsToUpdate.length} alertas`);
  } catch (error) {
    console.log(error);
  }
};

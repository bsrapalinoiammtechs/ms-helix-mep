import CiscoAlertsService from "./cisco.alerts.service";
import { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import { getAlarmsManual, getAlertsInGlpi, setIsTCpAlert, updateAlertResolved, saveAlert } from "./MongoDBService";
import { getNetworkData, getNetworkId, getSessionToken } from "./GlpiAPIService";
import { IAlert } from "../interfaces/IAlert";
import { IAlertHelix } from "../interfaces/IAlertHelix";
import lodash from "lodash";
import { AlertSeverityHelixEnum } from "../enums/AlertSeverityEnum";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { FieldEnum } from "../enums/FieldEnum";
import { sendAlertsToTcp } from "./TcpApiService";
import { INetworkGlpi } from "../interfaces/INetworkGlpiResponse";
import { DescriptionEnum } from "../enums/DescriptionEnum";

type IAlertCiscoGlpi = IAlertCisco & {
    descriptionGlpi: string;
    isGlpi: boolean;
    comment: string;
    location: string;
};

class CeseAlertsService {
    private static isProcessing = false;
    apiMeraki: any;
    timeDelay: number;
    baseDelay: number;
    lastAlertId: any | null;
    perPageLimit: number;
    organizationId: string;
    organizationName: string;
    maxAlertsToProccess: number;
    alertsProcessedCount: number;

    constructor() {
        this.timeDelay = 10000;
        this.baseDelay = 10000;
        this.lastAlertId = null;
        this.perPageLimit = 300;
        this.maxAlertsToProccess = 3000;
        this.alertsProcessedCount = 0;
        this.organizationId =  process.env["ORGANIZATION_ID"] || "";
        this.organizationName =  process.env["ORGANIZATION_NAME"] || "";

        this.apiMeraki = new CiscoAlertsService({
            active: false,
            resolved: true,
            perPage: 300,
            sortOrder: "descending"
        });
    }

    async getCeseAlerts () {
        while (true) {
            if (CeseAlertsService.isProcessing) {
              console.log("⚠️ Ya hay una ejecución en curso, se omite");
              await this.delay(60000); // Esperar 1 minuto antes del próximo ciclo
              continue;
            }
            
            CeseAlertsService.isProcessing = true;
            try {
            let hasMore = true;

            while (hasMore) {
                const result = await this.fetchAlerts();
                console.log("result.hasMore", result.hasMore)
                hasMore = result.hasMore;
                if (result.break) break;
                const resolvedAlerts = result.result;
                resolvedAlerts.forEach((a) => {
                   console.log(`CESE: id: ${a.id} type: ${a.type} item: ${ a.title} desc: ${a.description} resolvedAt: ${a.resolvedAt} device: ${JSON.stringify(a.scope.devices[0].productType)}`)
                })
                const allAlerts: IAlert[] = await getAlertsInGlpi();
                const activeAlerts: IAlert[]  = allAlerts.filter((a) => a.resolvedAt === null);
                console.log("getCeseAlerts->activeAlerts length", activeAlerts.length);
                const activeAlertsMap = new Map(
                  activeAlerts.map((alert) => [alert.alertId, alert])
                );
                const allAlertsMap = new Map(
                  allAlerts.map((alert) => [alert.alertId, alert])
                );
                const alertsToTcp: IAlert[] = [];

                const alertsToUpdate: { alertId: string; resolvedAt: string }[] =
                resolvedAlerts.filter(
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
                        console.log("CESE to updatedPromises, alertId: ", alertToUpdate.alertId, ", resolvedAt: ", alertToUpdate.resolvedAt, alertToUpdate);
                        const findAlertById = activeAlerts.find((a) => a.alertId === alertToUpdate.alertId);
                        if (findAlertById){
                            alertsToTcp.push({...findAlertById, resolvedAt: alertToUpdate.resolvedAt});
                        }
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

                // Procesar alertas nuevas que no están en el sistema
                const newAlerts = resolvedAlerts.filter(
                  (resolved) => !allAlertsMap.has(resolved.id)
                );

                if (newAlerts.length > 0) {
                  console.log(`CESE: Procesando ${newAlerts.length} alertas nuevas`);
                  const validatedNewAlerts = await this.validateAlertsWithGlpi(newAlerts);
                  
                  const saveNewAlertsPromises = validatedNewAlerts.map(
                    async (alertValidate: IAlertCiscoGlpi) => {
                      try {
                        const alertToSave: IAlert = {
                          alertId: alertValidate.id,
                          organization: {
                            id: this.organizationId,
                            name: this.organizationName,
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
                        console.log(`CESE: Alerta nueva guardada ${alertValidate.id}`);
                      } catch (error) {
                        console.error(
                          `Error al guardar la alerta nueva ${alertValidate.id}`,
                          error
                        );
                      }
                    }
                  );
                  await Promise.allSettled(saveNewAlertsPromises);
                }

                // await this.validateAndBuildAlertsToSend(alertsToTcp);
                await this.delay(result.timeDelay);
            }

        } catch (e) {
            console.error("Error en getCeseAlerts:", e);
        } finally {
            CeseAlertsService.isProcessing = false;
        }

        // Resetear contadores para el próximo ciclo
        this.alertsProcessedCount = 0;
        this.lastAlertId = null;

        console.log("### FINALIZADO CESE - Esperando próximo ciclo ###");
        await this.delay(30000); // Esperar 30 segundos antes del próximo ciclo
    }
}
  
    async fetchAlerts() {
      let response:{ hasMore: boolean, timeDelay: number, break: boolean, result:IAlertCisco[]} = {
          hasMore: false,
          timeDelay: this.timeDelay,
          break: false,
          result: []
      };
      try {
        console.log("this.alertsProcessedCount & this.maxAlertsToProccess: ", this.alertsProcessedCount, " &",this.maxAlertsToProccess)
          if (this.alertsProcessedCount >= this.maxAlertsToProccess) {
              return {
                  hasMore: false,
                  timeDelay: 0,
                  break: true,
                  result: [],
              };
          }

          let result: AxiosResponse<IAlertCisco[]>;
          const alerts: IAlertCisco[] = [];
              result = await this.apiMeraki.getAllMerakiAlertsApi(this.lastAlertId?.id);
               if (result.status === 200) {
                  const pageData = Array.isArray(result.data) ? result.data : [];
                  alerts.push(...pageData);
                  this.alertsProcessedCount += pageData.length;
                  response.hasMore = true;
                  this.lastAlertId = pageData[pageData.length - 1];
                  response.break = false;
                  response.result = pageData;
                  response.timeDelay =  this.getRetryDelay(result, 2);

                  if (this.alertsProcessedCount >= this.maxAlertsToProccess) {
                      response.hasMore = false;
                      response.break = false;
                      response.timeDelay = 0;
                  } else {
                      const lastAlert = pageData[pageData.length - 1];
                      if (!lastAlert?.id) {
                          console.warn("⚠️ [MERAKI API] No se encontró id en la última alerta. Finalizando paginación.");
                          response.break = true;
                          response.hasMore = false;
                          response.timeDelay = 0;
                          return response;
                      }
                  }
                  
                  return response;
              } else {
                  console.log("CESE = API_MERAKI: Error 429, intentando nuevamente");
                  response.break = false;
                  response.hasMore = true;
                  response.timeDelay =  5000;
                  return response;
              }
      } catch (e) {
               response.hasMore = true;
               response.break = false;
               response.timeDelay =  5000;
               return response;
      }
  }

  delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    getRetryDelay(response: AxiosResponse<any>, retryCount: number): number {
    const retryAfter = response.headers["retry-after"];
        if (retryAfter) {
            const retrySeconds = parseInt(String(retryAfter), 10);
            if (!Number.isNaN(retrySeconds) && retrySeconds >= 0) {
                return retrySeconds * 1000;
            }
        }
      return this.baseDelay * retryCount;
    }

    async validateAndBuildAlertsToSend(alerts: IAlert[]) {
        try {
            // const alerts: IAlert[] = await getAlertsInGlpi();
            const alertsToSend: IAlertHelix[] = await this.validateAlarmManual(alerts);
            const emitAlertsToHelix: { success: number; failed: number } = await sendAlertsToTcp(alertsToSend);
            console.log(`CESE = Resultado del envío a TCP: ${emitAlertsToHelix.success} exitosos, ${emitAlertsToHelix.failed} fallidos`, new Date(Date.now()).toLocaleString('es-CO'));
            const setIsTcp = alertsToSend.map(
                async (alertIsTcp: { alertId: string }) => {
                    try {
                        // console.log("CESE = isTcp, AlertId: ", alertIsTcp.alertId);
                        await setIsTCpAlert(alertIsTcp.alertId);
                        return (alertIsTcp.alertId);
                    } catch (error) {
                      console.error(
                        `Error al setear isTcp en la alerta ${alertIsTcp.alertId}`,
                        error
                      );
                      return null;
                    }
                });
                console.log("CESE = setIsTcp: ",setIsTcp.length)
        } catch (error) {
            console.log(error);
        }
    }

    async validateAlarmManual(alerts: IAlert[]) {
          const tipo: string = process.env.TIPO_ALERTA || FieldEnum.TIPO;
          const fase: string = process.env.FASE_ALERTA || FieldEnum.FASE;
        
          let alertsToSend: IAlertHelix[] = [];
          let alertNotSentCount = 0;
          for (const alert of alerts) {
            try {
              const alarmManual = await getAlarmsManual(
                alert.type,
                alert.scope.devices[0].productType
              );
    
              if (alarmManual.length > 0) {
                 console.log(`${alert.alertId} | ${ !lodash.isNull(alert.resolvedAt)
                ? AlertSeverityHelixEnum.CESE
                : alarmManual[0].severityHelix} | ${alert.resolvedAt}`);
                alertsToSend.push({
                  tipo: tipo,
                  idNotificacion: alert.alertId,
                  fechaHora: !lodash.isNull(alert.resolvedAt)
                    ? this.formatDateString(alert.resolvedAt)
                    : this.formatDateString(alert.startedAt),
                  nombreEquipo: alert.scope.devices[0].name,
                  ipEquipo: alert.scope.devices[0].mac,
                  causaEvento: alarmManual[0].categoryType,
                  evento: alarmManual[0].title,
                  severidadEvento: !lodash.isNull(alert.resolvedAt)
                    ? AlertSeverityHelixEnum.CESE
                    : alarmManual[0].severityHelix,
                  descripcionEvento: `${alarmManual[0].elementType} - ${alarmManual[0].categoryType} - ${alert.comment}`,
                  nombreCliente: alert.organization.name,
                  ubicacion: alert.location,
                  fase: fase,
                  alertId: alert.alertId,
                  organization: alert.organization,
                });
              }
            } catch (error) {
              alertNotSentCount = alertNotSentCount +1;
              console.error(
                `Error al validar la alerta ${alert.alertId} para envío manual, no se enviará a Helix`,
                error
              );
              // throw handleError(ErrorCode.E012, alert.alertId);
            }
          }
          return alertsToSend;
        }
    
        async validateDeviceNameInGlpi(
      nameDevice: string
    ): Promise<{
      descriptionGlpi: string;
      isGlpi: boolean;
      comment: string;
      location: string;
    }>{
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
    }

    async validateAlertsWithGlpi(alerts: IAlertCisco[]): Promise<IAlertCiscoGlpi[]> {
      let validateAlerts: IAlertCiscoGlpi[] = [];
      for (const alertCisco of alerts) {
        try {
          const validationGlpi: {
            descriptionGlpi: string;
            isGlpi: boolean;
            comment: string;
            location: string;
          } = await this.validateDeviceNameInGlpi(
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
            `CESE: No se pudo validar el dispositivo: ${alertCisco.scope.devices[0].name}`,
            error
          );
        }
      }
      return validateAlerts;
    }

    formatDateString(dateString: string | null): string {
            if (dateString === null) return "";
    
            const timeZone = "America/Costa_Rica";
            const date = new Date(dateString);
            const zonedDate = toZonedTime(date, timeZone);
            return format(zonedDate, "dd-MM-yyyy HH:mm:ss");
        }

}

export default CeseAlertsService;
import CiscoAlertsService from "./cisco.alerts.service";
import { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import { getNetworkData, getNetworkId, getSessionToken } from "./GlpiAPIService";
import { INetworkGlpi } from "../interfaces/INetworkGlpiResponse";
import { DescriptionEnum } from "../enums/DescriptionEnum";
import lodash from "lodash";
import { IAlert } from "../interfaces/IAlert";
import { saveAlert, setIsTCpAlert, handleReactivation, getExistingActiveAlertIds } from "./MongoDBService";
import { recordSync } from "../models/SyncState";
import { IAlertHelix } from "../interfaces/IAlertHelix";
import { FieldEnum } from "../enums/FieldEnum";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { AlertSeverityHelixEnum } from "../enums/AlertSeverityEnum";
import { sendAlertsToTcp } from "./TcpApiService";
import CatalogService from "./catalog.service";
import { log } from "../utils/logger";

type IAlertCiscoGlpi = IAlertCisco & {
    descriptionGlpi: string;
    isGlpi: boolean;
    comment: string;
    location: string;
};

class ActiveAlertsService {
    apiMeraki: any;
    timeDelay: number;
    baseDelay: number;
    lastAlertId: any | null;
    perPageLimit: number;
    organizationId: string;
    organizationName: string;
    maxAlertsToProccess: number;
    alertsProcessedCount: number;

    maxPagesPerCycle: number;

    constructor() {
        this.timeDelay = parseInt(process.env.CISCO_PAGE_DELAY_MS || "5000", 10);
        this.baseDelay = 5000;
        this.lastAlertId = null;
        this.perPageLimit = 300;
        this.maxAlertsToProccess = parseInt(process.env.CISCO_MAX_ALERTS || "10000", 10);
        this.maxPagesPerCycle = parseInt(process.env.CISCO_MAX_PAGES || "20", 10);
        this.alertsProcessedCount = 0;
        this.organizationId =  process.env["ORGANIZATION_ID"] || "";
        this.organizationName =  process.env["ORGANIZATION_NAME"] || "";

        this.apiMeraki = new CiscoAlertsService({
            active: true,
            resolved: false,
            perPage: 300,
            sortOrder: "descending"
        });
    }

    async getActiveAlerts () {
        const t0 = Date.now();
        let pagesScanned = 0;
        let totalAlertsSeen = 0;
        let totalNew = 0;
        let convergedAt: number | null = null;
        try {
            let hasMore = true;

            while (hasMore && pagesScanned < this.maxPagesPerCycle) {
                const result = await this.fetchAlerts();
                hasMore = result.hasMore;
                if (result.break) break;
                pagesScanned++;
                const pageData = result.result;
                totalAlertsSeen += pageData.length;
                if (pageData.length === 0) break;

                const ids = pageData.map((a) => a.id);
                const known = await getExistingActiveAlertIds(ids);

                const inCatalogPage: IAlertCisco[] = [];
                let notInCatalog = 0;
                for (const a of pageData) {
                    const productType = a.scope?.devices?.[0]?.productType ?? "";
                    if (await CatalogService.hasRule(a.type, productType)) {
                        inCatalogPage.push(a);
                    } else {
                        notInCatalog++;
                    }
                }

                const newOrChanged = inCatalogPage.filter((a) => !known.has(a.id));
                const knownInCatalog = inCatalogPage.length - newOrChanged.length;

                log.info("active.page.scanned", {
                    page: pagesScanned,
                    page_size: pageData.length,
                    not_in_catalog: notInCatalog,
                    in_catalog: inCatalogPage.length,
                    already_known: knownInCatalog,
                    new: newOrChanged.length,
                });

                if (newOrChanged.length === 0) {
                    convergedAt = pagesScanned;
                    log.info("active.converged", { pagesScanned, totalAlertsSeen });
                    break;
                }

                totalNew += newOrChanged.length;
                const validateAlerts = await this.validateAlertsWithGlpi(newOrChanged);
                const savePromises = validateAlerts.map(
                     async (alertValidate: IAlertCiscoGlpi) => {
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
                       if (alertToSave.resolvedAt === null || alertToSave.resolvedAt === undefined) {
                         await handleReactivation(alertToSave.alertId, alertToSave.startedAt);
                       }
                     }
                   );
                await Promise.all(savePromises);
                if (hasMore) await this.delay(result.timeDelay);
            }

            log.info("active.cycle.summary", {
                ms: Date.now() - t0,
                pages: pagesScanned,
                seen: totalAlertsSeen,
                new: totalNew,
                converged_at_page: convergedAt,
                hit_max_pages: pagesScanned >= this.maxPagesPerCycle,
            });

            await recordSync("cisco_active", {
                lastPageCount: totalAlertsSeen,
                lastNewCount: totalNew,
                lastPagesScanned: pagesScanned,
                metadata: { converged_at: convergedAt },
            });

        } catch (e: any) {
            console.error("Error en getActiveAlerts:", e);
            log.error("active.cycle.error", { message: e?.message });
            await recordSync("cisco_active", {
                lastPagesScanned: pagesScanned,
                lastError: e?.message ?? "unknown",
            });
        }

        this.alertsProcessedCount = 0;
        this.lastAlertId = null;
    }

    async fetchAlerts() {
        let response:{ hasMore: boolean, timeDelay: number, break: boolean, result:IAlertCisco[]} = {
            hasMore: false,
            timeDelay: this.timeDelay,
            break: false,
            result: []
        };
        try {
            if (this.alertsProcessedCount >= this.maxAlertsToProccess) {
                return {
                    hasMore: false,
                    timeDelay: 0,
                    break: true,
                    result: [],
                };
            }
            console.log("this.alertsProcessedCount & this.maxAlertsToProccess: ", this.alertsProcessedCount, " &",this.maxAlertsToProccess)
            let result: AxiosResponse<IAlertCisco[]>;
            const alerts: IAlertCisco[] = [];
                result = await this.apiMeraki.getAllMerakiAlertsApi(this.lastAlertId?.id);
                 if (result.status === 200) {
                    const pageData = Array.isArray(result.data) ? result.data : [];
                    alerts.push(...pageData);
                    this.alertsProcessedCount += pageData.length;
                    response.hasMore = true;
                    if (pageData.length > 0) {
                        this.lastAlertId = pageData[pageData.length - 1];
                    }
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
                    console.log("ACTIVE = API_MERAKI: Error 429, intentando nuevamente");
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

    sendAlertsToTcp(){

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
    };

    async validateAlertsWithGlpi(alerts: IAlertCisco[]){
        let validateAlerts: IAlertCiscoGlpi[] = [];
        let skippedNotInCatalog = 0;
        let glpiMatched = 0;
        let glpiUnmatched = 0;
        for (const alertCisco of alerts) {
            try {
              const productType = alertCisco.scope?.devices?.[0]?.productType ?? "";
              const type = alertCisco.type;
              const inCatalog = await CatalogService.hasRule(type, productType);
              if (!inCatalog) {
                skippedNotInCatalog++;
                continue;
              }

              const validationGlpi: {
                descriptionGlpi: string;
                isGlpi: boolean;
                comment: string;
                location: string;
              } = await this.validateDeviceNameInGlpi(
                lodash.defaultTo(alertCisco.scope.devices[0].name, "")
              );
              validateAlerts.push({
                ...alertCisco,
                descriptionGlpi: validationGlpi.descriptionGlpi,
                isGlpi: validationGlpi.isGlpi,
                comment: validationGlpi.comment,
                location: validationGlpi.location,
              });
              if (validationGlpi.isGlpi) glpiMatched++;
              else glpiUnmatched++;
            } catch (error) {
              console.warn(
                `No se pudo validar el dispositivo: ${alertCisco.scope.devices[0].name}`,
                error
              );
            }
        }
        if (skippedNotInCatalog > 0 || glpiUnmatched > 0) {
          log.info("active.alerts.validation", {
            received: alerts.length,
            skipped_not_in_catalog: skippedNotInCatalog,
            glpi_matched: glpiMatched,
            glpi_unmatched: glpiUnmatched,
          });
        }
        return validateAlerts;
    }

    async validateAndBuildAlertsToSend(alerts: IAlert[]) {
        try {
            const alertsToSend: IAlertHelix[] = await this.validateAlarmManual(alerts);
            const emitAlertsToHelix: { success: number; failed: number } = await sendAlertsToTcp(alertsToSend);
            console.log(`ACTIVE = Resultado del envío a TCP: ${emitAlertsToHelix.success} exitosos, ${emitAlertsToHelix.failed} fallidos`, new Date(Date.now()).toLocaleString('es-CO'));
            const setIsTcp = alertsToSend.map(
                async (alertIsTcp: { alertId: string }) => {
                    try {
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
                console.log("ACTIVE = setIsTcp: ", setIsTcp.length)
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
          const rule = await CatalogService.getRule(
            alert.type,
            alert.scope.devices[0].productType
          );

          if (rule) {
            console.log(`${alert.alertId} | ${ !lodash.isNull(alert.resolvedAt)
                ? AlertSeverityHelixEnum.CESE
                : rule.severityHelix} | ${alert.resolvedAt}`);
            alertsToSend.push({
              tipo: tipo,
              idNotificacion: alert.alertId,
              fechaHora: !lodash.isNull(alert.resolvedAt)
                ? this.formatDateString(alert.resolvedAt)
                : this.formatDateString(alert.startedAt),
              nombreEquipo: alert.scope.devices[0].name,
              ipEquipo: alert.scope.devices[0].mac,
              causaEvento: rule.categoryType,
              evento: rule.title,
              severidadEvento: !lodash.isNull(alert.resolvedAt)
                ? AlertSeverityHelixEnum.CESE
                : (rule.severityHelix as AlertSeverityHelixEnum),
              descripcionEvento: `${rule.elementType} - ${rule.categoryType} - ${alert.comment}`,
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
            `# Error al validar la alerta ${alert.alertId} para envío manual, no se enviará a Helix`,
            error
          );
        }
      }
      return alertsToSend;
    }

    formatDateString(dateString: string | null): string {
        if (dateString === null) return "";

        const timeZone = "America/Costa_Rica";
        const date = new Date(dateString);
        const zonedDate = toZonedTime(date, timeZone);
        return format(zonedDate, "dd-MM-yyyy HH:mm:ss");
    }
}

export default ActiveAlertsService;

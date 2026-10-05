import CiscoAlertsService, { parseAlertTypes } from "./cisco.alerts.service";
import { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import { getNetworkData, getNetworkId, getSessionToken } from "./GlpiAPIService";
import { INetworkGlpi } from "../interfaces/INetworkGlpiResponse";
import { DescriptionEnum } from "../enums/DescriptionEnum";
import lodash from "lodash";
import { IAlert } from "../interfaces/IAlert";
import { saveAlert, setIsTCpAlert, handleReactivation, getExistingActiveAlertIds, getExistingCesedAlertIds } from "./MongoDBService";
import { isStaleNetworkName } from "../utils/staleNetwork";
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
    perPageLimit: number;
    organizationId: string;
    organizationName: string;
    maxAlertsToProccess: number;
    alertsProcessedCount: number;

    maxPagesPerCycle: number;

    constructor() {
        this.timeDelay = parseInt(process.env.CISCO_PAGE_DELAY_MS || "5000", 10);
        this.baseDelay = 5000;
        this.perPageLimit = 300;
        this.maxAlertsToProccess = parseInt(process.env.CISCO_MAX_ALERTS || "10000", 10);
        this.maxPagesPerCycle = parseInt(process.env.CISCO_MAX_PAGES || "20", 10);
        this.alertsProcessedCount = 0;
        this.organizationId =  process.env["ORGANIZATION_ID"] || "";
        this.organizationName =  process.env["ORGANIZATION_NAME"] || "";

        // CISCO_ACTIVE_TYPES (lista separada por comas, opcional): limita el
        // polling de activas a esos tipos de Assurance. Pensado para cuando
        // otros tipos (ej. `unreachable`) ya llegan por webhook y no hace
        // falta pedirlos por polling. Sin definir: todos, como siempre.
        this.apiMeraki = new CiscoAlertsService({
            active: true,
            resolved: false,
            perPage: 300,
            sortOrder: "descending",
            types: parseAlertTypes(process.env.CISCO_ACTIVE_TYPES),
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
                const rawPageData = result.result;
                totalAlertsSeen += rawPageData.length;
                if (rawPageData.length === 0) break;

                // Excluye por completo las redes de "estacionamiento"
                // (RMA/pruebas, ver utils/staleNetwork.ts) -- ni siquiera se
                // guardan ni se reactivan. Sin esto, cualquier alerta que
                // staleAlertCleanup.service.ts haya cerrado se revive acá
                // mismo en <1 minuto: Meraki sigue reportando esos equipos
                // como activos para siempre (nunca se reconectan de
                // verdad), así que `saveAlert()` les vuelve a poner
                // resolvedAt:null en cada ciclo. Hallazgo real 30-sep-2026.
                const pageData = rawPageData.filter((a) => !isStaleNetworkName(a.network?.name));
                const staleNetworkSkipped = rawPageData.length - pageData.length;

                if (pageData.length === 0) {
                    log.info("active.page.scanned", {
                        page: pagesScanned,
                        page_size: rawPageData.length,
                        stale_network_skipped: staleNetworkSkipped,
                        not_in_catalog: 0,
                        in_catalog: 0,
                        already_known: 0,
                        new: 0,
                    });
                    if (hasMore) await this.delay(result.timeDelay);
                    continue;
                }

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
                    stale_network_skipped: staleNetworkSkipped,
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
                await this.persistValidatedAlerts(validateAlerts);
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
    }

    /**
     * Guarda en Mongo las alertas ya validadas contra catálogo y GLPI (y
     * reactiva las que Meraki volvió a levantar). Compartido entre el ciclo
     * de polling y `ingestActiveAlerts`.
     */
    async persistValidatedAlerts(validateAlerts: IAlertCiscoGlpi[]) {
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
    }

    /**
     * Procesa alertas activas ya traídas de la API de Meraki fuera del ciclo
     * de polling (la verificación por red que dispara el webhook, ver
     * workers/webhookAlerts.worker.ts): mismo filtro de redes estacionamiento,
     * de alertas ya conocidas, de catálogo + GLPI y mismo guardado que
     * `getActiveAlerts`.
     */
    async ingestActiveAlerts(alerts: IAlertCisco[]) {
        const pageData = alerts.filter((a) => !isStaleNetworkName(a.network?.name));
        const known = await getExistingActiveAlertIds(pageData.map((a) => a.id));
        const unknown = pageData.filter((a) => !known.has(a.id));
        const validated = await this.validateAlertsWithGlpi(unknown);
        await this.persistValidatedAlerts(validated);
        return {
            seen: alerts.length,
            stale_network_skipped: alerts.length - pageData.length,
            already_known: pageData.length - unknown.length,
            not_in_catalog: unknown.length - validated.length,
            saved: validated.length,
        };
    }

    /**
     * Guarda alertas que Meraki ya marcó RESUELTAS y que nunca llegamos a
     * guardar como activas -- una caída que duró lo bastante para que
     * Assurance la levantara pero que cesó antes de que `ingestActiveAlerts`
     * la consultara (visto 5-oct-2026: caídas de 22 a 24 min que producción
     * registró y `-wh` no). Mismo guardado que el polling de ceses con sus
     * alertas "nuevas ya resueltas" (cese.alerts.service.ts): se persisten con
     * su `resolvedAt` y quedan pendientes de envío.
     */
    async ingestResolvedAlerts(alerts: IAlertCisco[]) {
        const pageData = alerts.filter((a) => !isStaleNetworkName(a.network?.name));
        const ids = pageData.map((a) => a.id);
        const [activeIds, cesedIds] = await Promise.all([
            getExistingActiveAlertIds(ids),
            getExistingCesedAlertIds(ids),
        ]);
        const unknown = pageData.filter((a) => a.resolvedAt && !activeIds.has(a.id) && !cesedIds.has(a.id));
        const validated = await this.validateAlertsWithGlpi(unknown);
        await this.persistValidatedAlerts(validated);
        return {
            seen: alerts.length,
            stale_network_skipped: alerts.length - pageData.length,
            already_known: pageData.length - unknown.length,
            not_in_catalog: unknown.length - validated.length,
            saved: validated.length,
        };
    }

    /**
     * `hasMore` ya no depende de si la página trajo `id` en el último
     * elemento -- depende de `apiMeraki.hasNextPage()`, que a su vez viene
     * de si Meraki devolvió `Link: rel=next` (ver cisco.alerts.service.ts).
     * Ante error de red o status distinto de 200, se corta el ciclo
     * (`break:true, hasMore:false`) en vez de reintentar dentro del mismo
     * ciclo -- el próximo tick del cron (1 min) retoma desde la página 1.
     * Antes, ambas ramas de error dejaban `hasMore:true`, lo que podía
     * quedarse reintentando la misma página fallida hasta agotar
     * `maxPagesPerCycle` sin avanzar.
     */
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
            const result: AxiosResponse<IAlertCisco[]> | null = await this.apiMeraki.getAllMerakiAlertsApi();
            if (!result) {
                log.warn("active.fetch.network_error");
                return { hasMore: false, timeDelay: 0, break: true, result: [] };
            }
            if (result.status === 200) {
                const pageData = Array.isArray(result.data) ? result.data : [];
                this.alertsProcessedCount += pageData.length;
                response.break = false;
                response.result = pageData;
                response.timeDelay = this.getRetryDelay(result, 2);
                response.hasMore = this.apiMeraki.hasNextPage()
                    && this.alertsProcessedCount < this.maxAlertsToProccess;
                return response;
            } else {
                log.warn("active.fetch.unexpected_status", { status: result.status });
                response.break = true;
                response.hasMore = false;
                response.timeDelay = 0;
                return response;
            }
        } catch (e: any) {
            log.error("active.fetch.exception", { message: e?.message });
            response.hasMore = false;
            response.break = true;
            response.timeDelay = 0;
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

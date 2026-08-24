import { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import { fetchMerakiPage } from "../queues/meraki.queue";
import { log } from "../utils/logger";

type MerakiParams = {
  active: boolean;
  resolved: boolean;
  perPage: number;
  sortOrder: string;
  sortBy?: string;
}

class CiscoAlertsService {
  orgid: string;
  token: string;
  alertsProcessed: number;
  alertTcpSent: number;
  retry: boolean;
  params: MerakiParams;

  // Estado de paginación de ESTE ciclo (una instancia de CiscoAlertsService
  // vive lo que dura un getActiveAlerts()/getCeseAlerts() -- se crea de
  // nuevo en cada tick del cron). null = próxima llamada es la página 1.
  private nextUrl: string | null = null;

  constructor({ active, resolved, perPage, sortOrder, sortBy }: MerakiParams) {
    this.orgid =  process.env["ORGANIZATION_ID"] || "";
    this.token =  process.env["TOKEN_CISCO"] || "";
    this.alertsProcessed = 0;
    this.alertTcpSent = 0;
    this.retry = false;
    this.params = {
      active,
      resolved,
      perPage,
      sortOrder,
      ...(sortBy ? { sortBy } : {}),
    };
  }

  /**
   * Encola la petición en el gateway compartido (`meraki.queue.ts`) y
   * espera su turno -- el worker de ese gateway reintenta ante 429
   * respetando Retry-After.
   *
   * Paginación: sigue el header `Link: rel=next` de la respuesta, tal como
   * exige la documentación oficial de Meraki -- NUNCA construyendo
   * `startingAfter` a mano desde el `id` de una alerta:
   *
   *   "startingAfter ... This parameter should not be defined by client
   *    applications. The link for the first, last, prev, or next page in
   *    the HTTP Link header should define it."
   *   https://developer.cisco.com/meraki/api-v1/get-organization-assurance-alerts/
   *
   * (Antes este código armaba `startingAfter=<lastAlert.id>` a mano -- no
   * hay garantía de que ese id sea un token de paginación válido para
   * Meraki. Con tráfico normal nunca se nota porque todo cabe en la
   * página 1; el riesgo real aparece cuando en un solo ciclo aparecen más
   * de `perPage` alertas nuevas/resueltas de golpe, típicamente durante
   * una caída masiva -- justo cuando más importa no perder alertas.)
   *
   * No se pasa Authorization acá: el worker lo arma desde
   * process.env.TOKEN_CISCO (ver nota en meraki.queue.ts).
   */
  async getAllMerakiAlertsApi(): Promise<AxiosResponse<IAlertCisco[]> | null> {
    const baseUrl = `https://api.meraki.com/api/v1/organizations/${this.orgid}/assurance/alerts`;
    const isFirstPage = this.nextUrl === null;

    const result = await fetchMerakiPage({
      url: isFirstPage ? baseUrl : this.nextUrl!,
      params: isFirstPage ? { ...this.params } : undefined,
      headers: { "Content-Type": "application/json" },
    });

    if (!result) {
      log.error("cisco.fetch.network_error", {});
      this.nextUrl = null;
      return null;
    }

    this.nextUrl = result.status === 200 ? this.extractNextUrl(result.headers) : null;

    return {
      status: result.status,
      data: result.data,
      headers: result.headers,
    } as AxiosResponse<IAlertCisco[]>;
  }

  /** true si la última respuesta trajo `Link: rel=next` -- hay más páginas. */
  hasNextPage(): boolean {
    return this.nextUrl !== null;
  }

  private extractNextUrl(headers: Record<string, any>): string | null {
    const linkHeader = String(headers?.["link"] || "");
    const match = linkHeader.match(/<([^>]+)>;\s*rel=next/);
    return match?.[1] ?? null;
  }
}

export default CiscoAlertsService;

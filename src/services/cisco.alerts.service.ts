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

  buildHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Ya no llama a Meraki directamente: encola la petición en el gateway
   * compartido (`meraki.queue.ts`) y espera su turno. El worker de ese
   * gateway es quien reintenta ante 429 respetando Retry-After -- esta
   * clase ya no necesita su propio loop de reintentos, así queda un solo
   * lugar (`meraki.worker.ts`) que decide cuándo y cómo reintentar.
   */
  async getAllMerakiAlertsApi(
    startingAfter: any = null,
  ): Promise<AxiosResponse<IAlertCisco[]> | null> {
    const url = `https://api.meraki.com/api/v1/organizations/${this.orgid}/assurance/alerts`;
    const params: Record<string, any> = startingAfter !== null
      ? { ...this.params, startingAfter }
      : { ...this.params };

    const result = await fetchMerakiPage({ url, params, headers: this.buildHeaders() });
    if (!result) {
      log.error("cisco.fetch.network_error", {});
      return null;
    }
    return {
      status: result.status,
      data: result.data,
      headers: result.headers,
    } as AxiosResponse<IAlertCisco[]>;
  }
}

export default CiscoAlertsService;

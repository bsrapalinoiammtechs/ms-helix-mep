import axios, { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";

type MerakiParams = {
  active: boolean;
  resolved: boolean;
  perPage: number;
  sortOrder: string;
}
class CiscoAlertsService {
  orgid: string;
  token: string;
  alertsProcessed: number;
  alertTcpSent: number;
  retry: boolean;
  params: MerakiParams;
  
  constructor({ active, resolved, perPage, sortOrder}: MerakiParams) {
    this.orgid =  process.env["ORGANIZATION_ID"] || "";
    this.token =  process.env["TOKEN_CISCO"] || "";
    this.alertsProcessed = 0;
    this.alertTcpSent = 0;
    this.retry = false;
    this.params = {
      active: active,
      resolved: resolved,
      perPage: perPage,
      sortOrder: sortOrder,
    };
  }

  buildHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async fetchPage(
  url: string,
  params: Record<string, any>,
  headers: Record<string, string>,
): Promise<AxiosResponse<IAlertCisco[]>> {
  try {
    return await axios.get<IAlertCisco[]>(url, {
      headers,
      params,
      validateStatus: () => true,
    });
  } catch (error) {
    console.error("🚨 2 [MERAKI API] Error de conexión o request fallido", error);
    throw error;
  }
}

  async getAllMerakiAlertsApi(startingAfter: any = null){
    const url = `https://api.meraki.com/api/v1/organizations/${this.orgid}/assurance/alerts`;
    let response: AxiosResponse<IAlertCisco[]>;
    try {
      let startingAfterParam = null;
      if (startingAfter !== null) {
        startingAfterParam = { startingAfter };
      }
      response = await this.fetchPage(url, {...this.params, ...startingAfterParam}, this.buildHeaders());
       return response;
    } catch (error) {
      console.error("🚨 2 [MERAKI API] No se pudo obtener la página de alertas", error);
      return error;
    }
  }

}

export default CiscoAlertsService;




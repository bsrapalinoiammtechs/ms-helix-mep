import axios, { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import { log } from "../utils/logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private readonly maxRetries: number;
  private readonly defaultRetryAfterSec: number;

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
    this.maxRetries = parseInt(process.env.CISCO_429_MAX_RETRIES || "5", 10);
    this.defaultRetryAfterSec = parseInt(process.env.CISCO_429_DEFAULT_RETRY_SEC || "10", 10);
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
    return axios.get<IAlertCisco[]>(url, {
      headers,
      params,
      validateStatus: () => true,
      timeout: 30000,
    });
  }

  async getAllMerakiAlertsApi(
    startingAfter: any = null,
  ): Promise<AxiosResponse<IAlertCisco[]> | null> {
    const url = `https://api.meraki.com/api/v1/organizations/${this.orgid}/assurance/alerts`;
    const params: Record<string, any> = startingAfter !== null
      ? { ...this.params, startingAfter }
      : { ...this.params };

    let attempt = 0;
    for (;;) {
      let response: AxiosResponse<IAlertCisco[]>;
      try {
        response = await this.fetchPage(url, params, this.buildHeaders());
      } catch (error: any) {
        log.error("cisco.fetch.network_error", {
          attempt,
          message: error?.message,
        });
        return null;
      }

      if (response.status !== 429) {
        if (attempt > 0) {
          log.info("cisco.429.recovered", {
            attempt,
            status: response.status,
          });
        }
        return response;
      }

      attempt++;
      if (attempt > this.maxRetries) {
        log.warn("cisco.429.exhausted", {
          attempt,
          max_retries: this.maxRetries,
        });
        return response;
      }

      const headerVal = response.headers["retry-after"];
      const parsed = parseInt(String(headerVal ?? this.defaultRetryAfterSec), 10);
      const retryAfterSec = Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : this.defaultRetryAfterSec;
      const waitMs = (retryAfterSec + 2) * 1000;
      log.warn("cisco.429.retry", {
        attempt,
        max_retries: this.maxRetries,
        wait_ms: waitMs,
        retry_after_header: headerVal ?? null,
      });
      await sleep(waitMs);
    }
  }
}

export default CiscoAlertsService;

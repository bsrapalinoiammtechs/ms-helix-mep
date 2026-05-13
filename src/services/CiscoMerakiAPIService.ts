import axios, { AxiosResponse } from "axios";
import { IAlertCisco } from "../interfaces/IAlertCisco";
import { log } from "../utils/logger";

const DEFAULT_PER_PAGE = 300;
const DEFAULT_SORT_ORDER = "descending";
const MAX_RETRIES = parseInt(process.env.CISCO_429_MAX_RETRIES || "5", 10);
const RETRY_BASE_DELAY_MS = 5000;
const PAGE_DELAY_MS = 2000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

function buildHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getRetryDelay(response: AxiosResponse<any>, retryCount: number): number {
  const retryAfter = response.headers["retry-after"];
  if (retryAfter) {
    const retrySeconds = parseInt(String(retryAfter), 10);
    if (!Number.isNaN(retrySeconds) && retrySeconds >= 0) {
      return retrySeconds * 1000;
    }
  }

  return RETRY_BASE_DELAY_MS * retryCount;
}

async function fetchPage(
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
    console.error("🚨 [MERAKI API] Error de conexión o request fallido", error);
    throw error;
  }
}

async function fetchAllAlerts(params: Record<string, any>, enableRefetch: boolean = true): Promise<IAlertCisco[]> {
  const orgId = getRequiredEnv("ORGANIZATION_ID");
  const token = getRequiredEnv("TOKEN_CISCO");
  const url = `https://api.meraki.com/api/v1/organizations/${orgId}/assurance/alerts`;

  const allAlerts: IAlertCisco[] = [];
  let queryParams = { ...params };
  let hasMore = true;
  let retryCount = 0;

  while (hasMore) {
    let response: AxiosResponse<IAlertCisco[]>;

    try {
      response = await fetchPage(url, queryParams, buildHeaders(token));
    } catch (error) {
      console.error("🚨 [MERAKI API] No se pudo obtener la página de alertas", error);
      break;
    }

    console.log(
      `📡 [MERAKI API] Status: ${response.status} | ${new Date().toLocaleString("es-CO")}`,
    );

    if (response.status === 429) {
      retryCount += 1;
      if (retryCount > MAX_RETRIES) {
        log.warn("cisco_module.429.exhausted", {
          max_retries: MAX_RETRIES,
          collected: allAlerts.length,
        });
        break;
      }

      const waitTimeMs = getRetryDelay(response, retryCount);
      log.warn("cisco_module.429.retry", {
        attempt: retryCount,
        max_retries: MAX_RETRIES,
        wait_ms: waitTimeMs,
      });
      await delay(waitTimeMs);
      continue;
    }

    retryCount = 0;

    if (response.status >= 400) {
      console.error(
        `🚨 [MERAKI API] Respuesta no válida: ${response.status}`,
        response.data ?? response.statusText,
      );
      break;
    }

    const pageData = Array.isArray(response.data) ? response.data : [];
    allAlerts.push(...pageData);
    //despues del llenado detener el servicio
    
    const perPageLimit = queryParams.perPage ?? DEFAULT_PER_PAGE;
    console.log(`📊 [MERAKI API] Alertas obtenidas en esta página: ${pageData.length} | Total acumulado: ${perPageLimit} `, pageData.length < perPageLimit);
    if (!enableRefetch) break;
    if (pageData.length < perPageLimit) {
      hasMore = false;
    } else {
      const lastAlert = pageData[pageData.length - 1];
      if (!lastAlert?.id) {
        console.warn("⚠️ [MERAKI API] No se encontró id en la última alerta. Finalizando paginación.");
        break;
      }
      queryParams = { ...queryParams, startingAfter: lastAlert.id };
    }
    await delay(PAGE_DELAY_MS);
  }
  console.log("!!!!!! allAlerts: ", allAlerts.length,`  | ${new Date(Date.now()).toLocaleString('es-CO')}`);
  return allAlerts;
}

export async function getListOfActiveAlerts(): Promise<IAlertCisco[]> {
  try {
    return await fetchAllAlerts({
      active: true,
      resolved: false,
      perPage: DEFAULT_PER_PAGE,
      sortOrder: DEFAULT_SORT_ORDER,
    });
  } catch (error) {
    console.error("🚨 [MERAKI SERVICE] Error obteniendo alertas activas", error);
    return [];
  }
}

export async function getListOfResolvedAlerts(): Promise<IAlertCisco[]> {
  try {
    return await fetchAllAlerts({
      active: false,
      resolved: true,
      perPage: DEFAULT_PER_PAGE,
      sortOrder: DEFAULT_SORT_ORDER,
    }, true);
  } catch (error) {
    console.error("🚨 [MERAKI SERVICE] Error obteniendo alertas resueltas", error);
    return [];
  }
}

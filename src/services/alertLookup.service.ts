import { fetchMerakiPage } from "../queues/meraki.queue";
import { log } from "../utils/logger";

/**
 * Consulta puntual de alertas por id contra Meraki -- mismo endpoint y
 * misma lógica de clasificación que ya usa validador.py
 * (consultar_alerta_meraki_por_id): GET
 * /organizations/{orgId}/assurance/alerts/{id}, 404 real = no encontrada,
 * con resolvedAt/dismissedAt = cesada, si no = activa.
 *
 * Pasa por el mismo gateway con rate-limit (queues/meraki.queue.ts +
 * workers/meraki.worker.ts, concurrency:1 + 1 job por MERAKI_RATE_DELAY_MS)
 * que ya usa el resto de la app -- no le pega directo a axios, para no
 * arriesgar otro 429 en cadena si se consultan muchos ids de una vez.
 */

const API_BASE = "https://api.meraki.com/api/v1";

export type AlertLookupStatus = "ACTIVA" | "CESADA" | "NO_ENCONTRADA" | "ERROR";

export interface AlertLookupResult {
  alertId: string;
  estado: AlertLookupStatus;
  startedAt?: string;
  resolvedAt?: string;
  dismissedAt?: string;
  networkId?: string;
  networkName?: string;
  deviceName?: string;
  type?: string;
  title?: string;
  error?: string;
}

async function lookupOne(organizationId: string, alertId: string): Promise<AlertLookupResult> {
  const url = `${API_BASE}/organizations/${organizationId}/assurance/alerts/${alertId}`;
  const result = await fetchMerakiPage({ url, method: "GET" }, "alert-lookup");

  if (!result) {
    return { alertId, estado: "ERROR", error: "El gateway de Meraki no devolvió respuesta (ver logs del worker)" };
  }
  if (result.status === 404) {
    return { alertId, estado: "NO_ENCONTRADA" };
  }
  if (result.status < 200 || result.status >= 300) {
    return { alertId, estado: "ERROR", error: `Meraki respondió ${result.status}` };
  }

  const alerta = result.data ?? {};
  const estado: AlertLookupStatus = alerta.resolvedAt || alerta.dismissedAt ? "CESADA" : "ACTIVA";
  return {
    alertId,
    estado,
    startedAt: alerta.startedAt,
    resolvedAt: alerta.resolvedAt ?? undefined,
    dismissedAt: alerta.dismissedAt ?? undefined,
    networkId: alerta.network?.id,
    networkName: alerta.network?.name,
    deviceName: alerta.scope?.devices?.[0]?.name,
    type: alerta.type,
    title: alerta.title,
  };
}

// Se dispara todo con Promise.all a propósito -- los jobs se encolan de
// inmediato, pero concurrency:1 en el worker igual los va a procesar uno
// por uno respetando MERAKI_RATE_DELAY_MS. Con muchos ids esto tarda: N
// alertas * MERAKI_RATE_DELAY_MS (11s default) -- ej. 85 ids ~= 15 min. Es
// una herramienta de diagnóstico puntual, no un endpoint de alta
// frecuencia, así que se prioriza no romper el rate-limit por sobre la
// latencia de la respuesta.
export async function lookupAlerts(organizationId: string, alertIds: string[]): Promise<AlertLookupResult[]> {
  const uniqueIds = Array.from(new Set(alertIds.map((id) => String(id).trim()).filter(Boolean)));
  log.info("alert_lookup.start", { organizationId, count: uniqueIds.length });

  const results = await Promise.all(uniqueIds.map((id) => lookupOne(organizationId, id)));

  log.info("alert_lookup.done", {
    organizationId,
    total: results.length,
    activa: results.filter((r) => r.estado === "ACTIVA").length,
    cesada: results.filter((r) => r.estado === "CESADA").length,
    no_encontrada: results.filter((r) => r.estado === "NO_ENCONTRADA").length,
    error: results.filter((r) => r.estado === "ERROR").length,
  });

  return results;
}

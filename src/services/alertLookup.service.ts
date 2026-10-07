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

// Cuántas consultas van en vuelo a la vez. El worker del gateway atiende una
// por MERAKI_RATE_DELAY_MS, y el cliente espera su turno como máximo
// MERAKI_JOB_WAIT_TIMEOUT_MS (10 min). Encolar todo de golpe hacía que, con 60
// ids y 30 s por consulta, solo 20 terminaran a tiempo: las otras 40 se daban
// por fallidas pero sus jobs seguían en la cola, gastando consultas y
// bloqueando a los pollers. Con una ventana pequeña ninguna espera más de
// LOOKUP_CONCURRENCY * MERAKI_RATE_DELAY_MS, y el resto del tráfico se
// intercala entre ellas.
const LOOKUP_CONCURRENCY = Math.max(1, parseInt(process.env.ALERT_LOOKUP_CONCURRENCY || "3", 10));

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function lookupAlerts(organizationId: string, alertIds: string[]): Promise<AlertLookupResult[]> {
  const uniqueIds = Array.from(new Set(alertIds.map((id) => String(id).trim()).filter(Boolean)));
  log.info("alert_lookup.start", { organizationId, count: uniqueIds.length, concurrency: LOOKUP_CONCURRENCY });

  const results = await mapWithLimit(uniqueIds, LOOKUP_CONCURRENCY, (id) => lookupOne(organizationId, id));

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

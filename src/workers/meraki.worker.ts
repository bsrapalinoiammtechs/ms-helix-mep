import { Worker, Job } from "bullmq";
import axios, { AxiosResponse } from "axios";
import { redisConnection } from "../config/redis";
import { MERAKI_QUEUE_NAME, MerakiHttpRequest, MerakiHttpResult } from "../queues/meraki.queue";
import { log } from "../utils/logger";

/**
 * Único consumidor de `meraki-api-calls`. Ejecuta la petición HTTP real a
 * Meraki, reintentando internamente ante 429 (respetando `Retry-After`,
 * igual que ya hacía `CiscoAlertsService.getAllMerakiAlertsApi` y
 * `ReconciliationService.fetchResolvedAlertsForNetwork` cada uno por su
 * lado -- esa lógica se centralizó acá, un solo lugar que la mantiene).
 *
 * `concurrency: 1` + `limiter: { max: 1, duration: MERAKI_RATE_DELAY_MS }`
 * es lo que impone el espaciado real entre llamadas a Meraki, sin importar
 * si la piden `active`, `cese` o `reconciliation`.
 */

const RATE_DELAY_MS = parseInt(process.env.MERAKI_RATE_DELAY_MS || "11000", 10);
const MAX_RETRIES = parseInt(process.env.CISCO_429_MAX_RETRIES || "5", 10);
const DEFAULT_RETRY_AFTER_SEC = parseInt(process.env.CISCO_429_DEFAULT_RETRY_SEC || "10", 10);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// El token vive acá, no en job.data -- ver nota en meraki.queue.ts. Se lee
// una vez al cargar el módulo porque .env no cambia sin reiniciar el
// contenedor (igual que ya asumían CiscoAlertsService/ReconciliationService).
const TOKEN_CISCO = process.env.TOKEN_CISCO || "";

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...extra,
    Authorization: `Bearer ${TOKEN_CISCO}`,
  };
}

async function processMerakiRequest(job: Job<MerakiHttpRequest>): Promise<MerakiHttpResult> {
  const { url, params, headers, timeoutMs } = job.data;
  let attempt = 0;

  for (;;) {
    let response: AxiosResponse<any>;
    try {
      response = await axios.get(url, {
        headers: buildAuthHeaders(headers),
        params,
        timeout: timeoutMs ?? 30000,
        validateStatus: () => true,
      });
    } catch (error: any) {
      log.error("meraki.worker.network_error", {
        jobId: job.id,
        attempt,
        message: error?.message,
      });
      // El job queda failed; fetchMerakiPage() lo traduce a `null` para el
      // llamador, igual que el contrato previo ante error de red.
      throw error;
    }

    if (response.status !== 429) {
      if (attempt > 0) {
        log.info("meraki.worker.429_recovered", {
          jobId: job.id,
          attempt,
          status: response.status,
        });
      }
      return { status: response.status, data: response.data, headers: { ...response.headers } };
    }

    attempt++;
    if (attempt > MAX_RETRIES) {
      log.warn("meraki.worker.429_exhausted", {
        jobId: job.id,
        attempt,
        max_retries: MAX_RETRIES,
      });
      return { status: 429, data: response.data, headers: { ...response.headers } };
    }

    const headerVal = response.headers["retry-after"];
    const parsed = parseInt(String(headerVal ?? DEFAULT_RETRY_AFTER_SEC), 10);
    const retryAfterSec = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRY_AFTER_SEC;
    const waitMs = (retryAfterSec + 2) * 1000;
    log.warn("meraki.worker.429_retry", {
      jobId: job.id,
      attempt,
      max_retries: MAX_RETRIES,
      wait_ms: waitMs,
      retry_after_header: headerVal ?? null,
    });
    await sleep(waitMs);
  }
}

export const merakiWorker = new Worker<MerakiHttpRequest, MerakiHttpResult>(
  MERAKI_QUEUE_NAME,
  processMerakiRequest,
  {
    connection: redisConnection,
    concurrency: 1,
    limiter: { max: 1, duration: RATE_DELAY_MS },
  },
);

merakiWorker.on("error", (err) => {
  log.error("meraki.worker.error", { message: err?.message });
});

merakiWorker.on("failed", (job, err) => {
  log.warn("meraki.worker.job_failed", { jobId: job?.id, message: err?.message });
});

log.info("meraki.worker.started", {
  rate_delay_ms: RATE_DELAY_MS,
  max_retries: MAX_RETRIES,
  default_retry_after_sec: DEFAULT_RETRY_AFTER_SEC,
});

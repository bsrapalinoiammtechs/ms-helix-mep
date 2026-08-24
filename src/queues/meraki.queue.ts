import { Queue, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";

/**
 * Gateway central para TODAS las llamadas HTTP a la API de Meraki de esta
 * organización.
 *
 * Antes de esto, `ActiveAlertsService`, `CeseAlertsService` y
 * `ReconciliationService` llamaban a Meraki cada uno por su cuenta, con su
 * propio delay local entre páginas (5s los dos primeros, 11s el tercero) --
 * pero nada impedía que sus 3 crons dispararan peticiones al mismo tiempo.
 * Meraki aplica el rate-limit sobre la organización sin importar cuál de
 * los 3 flujos hizo la petición, así que la concurrencia ENTRE ellos (no
 * solo la paginación dentro de cada uno) es la causa raíz de los 429
 * persistentes reportados por el cliente -- ver
 * `01_FIX_ALERTAS_RETENIDAS_2026-05-12.md`, sección 3, y la sección D
 * agregada al final de ese documento.
 *
 * Esta cola + su Worker (`../workers/meraki.worker.ts`) son el único punto
 * de paso hacia Meraki: cualquier servicio que necesite una página encola
 * un job acá y espera el resultado. El Worker, con concurrency:1 y un
 * limiter de 1 job por `MERAKI_RATE_DELAY_MS`, garantiza que nunca salgan
 * 2 peticiones reales a Meraki más cerca entre sí que ese intervalo, sin
 * importar cuántos crons las dispararon "al mismo tiempo".
 */

export const MERAKI_QUEUE_NAME = "meraki-api-calls";

// Margen amplio: el worker puede tardar varios minutos en un job si Meraki
// sigue devolviendo 429 y hay que agotar CISCO_429_MAX_RETRIES respetando
// Retry-After. No queremos que el productor se rinda mientras el worker
// todavía está reintentando de buena fe.
const JOB_WAIT_TIMEOUT_MS = parseInt(
  process.env.MERAKI_JOB_WAIT_TIMEOUT_MS || String(10 * 60 * 1000),
  10,
);

export const merakiQueue = new Queue(MERAKI_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Los reintentos de 429 se manejan DENTRO del worker (respetando
    // Retry-After), no vía el mecanismo de reintento de BullMQ -- así un
    // job = una llamada lógica a Meraki (con o sin reintentos internos),
    // y el productor solo necesita esperar UN evento completed/failed.
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

export const merakiQueueEvents = new QueueEvents(MERAKI_QUEUE_NAME, {
  connection: redisConnection,
});

merakiQueueEvents.on("error", (err) => {
  log.error("meraki.queue_events.error", { message: err?.message });
});

export type MerakiHttpRequest = {
  url: string;
  params?: Record<string, any>;
  headers: Record<string, string>;
  timeoutMs?: number;
};

export type MerakiHttpResult = {
  status: number;
  data: any;
  headers: Record<string, any>;
};

/**
 * Encola una petición HTTP a Meraki y espera su resultado, respetando el
 * turno asignado por el rate-limiter del worker. Devuelve `null` solo si
 * el job no pudo completarse (error de red irrecuperable dentro del
 * worker, o timeout esperando turno) -- mismo contrato que ya tenía
 * `getAllMerakiAlertsApi`, que devolvía `null` en error de red.
 */
export async function fetchMerakiPage(
  req: MerakiHttpRequest,
  jobName = "fetch-page",
): Promise<MerakiHttpResult | null> {
  const job = await merakiQueue.add(jobName, req);
  try {
    const result = await job.waitUntilFinished(merakiQueueEvents, JOB_WAIT_TIMEOUT_MS);
    return result as MerakiHttpResult;
  } catch (error: any) {
    log.error("meraki.gateway.job_failed", {
      jobId: job.id,
      message: error?.message,
    });
    return null;
  }
}

export async function closeMerakiQueue() {
  await merakiQueueEvents.close();
  await merakiQueue.close();
}

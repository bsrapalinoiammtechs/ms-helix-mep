import { Queue, QueueEvents, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { log } from "../utils/logger";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";

/**
 * Cola para alertas ACTIVAS recibidas por webhook de Meraki (push), en vez
 * de por polling. Independiente de `meraki.queue.ts` (ese es el gateway de
 * SALIDA hacia la API REST de Meraki, con rate-limit propio) -- acá no hay
 * ningún límite de Meraki que respetar, Meraki ya nos empujó el dato. Se
 * encola de todas formas para no bloquear la respuesta HTTP mientras se
 * procesa (catálogo, GLPI, Mongo) -- Meraki espera un 2xx rápido y
 * deshabilita el receptor si falla consistentemente.
 *
 * Solo alertas activas (raised) por ahora -- el cese/resolución queda
 * pendiente de decidir si comparte este mismo flujo o va en un endpoint
 * aparte (ver 01_FIX_ALERTAS_RETENIDAS_2026-05-12.md, sección FASE C).
 */

export const WEBHOOK_ALERTS_QUEUE_NAME = "meraki-webhook-alerts";

export const webhookAlertsQueue = new Queue(WEBHOOK_ALERTS_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // A diferencia del gateway de salida (attempts:1, retries manuales
    // respetando Retry-After), acá SÍ tiene sentido el retry normal de
    // BullMQ: es solo "reintentar guardar/validar", no hay contrato de
    // rate-limit externo que romper.
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

export const webhookAlertsQueueEvents = new QueueEvents(WEBHOOK_ALERTS_QUEUE_NAME, {
  connection: redisConnection,
});

webhookAlertsQueueEvents.on("error", (err) => {
  log.error("webhook_alerts.queue_events.error", { message: err?.message });
});

/**
 * Encola el payload crudo del webhook tal cual llegó -- el mapeo hacia
 * nuestro formato interno (`IAlertCisco`, vía `mapMerakiWebhookAlert`) pasa
 * DENTRO del Worker (`workers/webhookAlerts.worker.ts`), no acá, para que
 * la ruta HTTP responda a Meraki lo más rápido posible.
 *
 * `sharedSecret` se descarta ACÁ antes de encolar -- ya cumplió su
 * propósito en `merakiWebhookAuth` (corre antes que este handler, valida y
 * corta con 401 si no coincide). Guardarlo en job.data lo dejaría en texto
 * plano visible para cualquiera con acceso al dashboard de bull-board
 * (encontrado en vivo, 29-sep-2026, revisando jobs reales de prueba).
 */
export async function enqueueWebhookAlert(
  payload: MerakiWebhookAlertPayload,
): Promise<Job> {
  const { sharedSecret, ...sanitizedPayload } = payload;
  const job = await webhookAlertsQueue.add("raised-alert", sanitizedPayload);
  await scheduleNetworkVerification(sanitizedPayload);
  return job;
}

/**
 * Verificación por red disparada por webhook: un `stopped_reporting` es solo
 * el aviso de que algo se cayó en esa red -- no trae equipo ni el id de la
 * alerta de Assurance, y la mitad son parpadeos que Assurance nunca eleva
 * (medido 5-oct-2026: producción solo registra caídas de 15 min o más). Se
 * agenda una consulta a la API de Meraki pasado ese umbral, para que Assurance
 * decida qué es alerta real y traiga el detalle por equipo y el id real.
 *
 * Desactivado por defecto: solo `-wh` lo activa con
 * WEBHOOK_VERIFY_ENABLED=true. La consulta real y su agrupación por red viven
 * en `workers/webhookAlerts.worker.ts` (processNetworkVerification).
 */
export const VERIFY_NETWORK_JOB_NAME = "verify-network";

const VERIFY_ENABLED = process.env.WEBHOOK_VERIFY_ENABLED === "true";
const VERIFY_DELAY_MS = parseInt(
  process.env.WEBHOOK_VERIFY_DELAY_MS || String(15 * 60 * 1000),
  10,
);

export interface VerifyNetworkJobData {
  networkId: string;
  networkName: string;
  organizationId: string;
  eventAt: string;
}

async function scheduleNetworkVerification(payload: MerakiWebhookAlertPayload) {
  if (!VERIFY_ENABLED || payload.alertType !== "stopped_reporting" || !payload.networkId) {
    return;
  }
  // Un fallo acá no debe devolver 500 a Meraki: reintentaría el mismo
  // payload y duplicaría el aviso. El polling sigue cubriendo la alerta.
  try {
    const data: VerifyNetworkJobData = {
      networkId: payload.networkId,
      networkName: payload.networkName ?? "",
      organizationId: payload.organizationId ?? "",
      eventAt: payload.startedAt ?? payload.sentAt ?? new Date().toISOString(),
    };
    // Un job por evento, sin jobId: cada caída se verifica 15 min DESPUÉS de
    // su propio aviso. La agrupación (una sola consulta cuando 10 APs de la
    // misma sede caen juntos) se hace al ejecutar, con un candado por red.
    await webhookAlertsQueue.add(VERIFY_NETWORK_JOB_NAME, data, {
      delay: VERIFY_DELAY_MS,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (err: any) {
    log.warn("webhook_verify.schedule_failed", {
      networkId: payload.networkId,
      message: err?.message,
    });
  }
}

export async function closeWebhookAlertsQueue() {
  await webhookAlertsQueueEvents.close();
  await webhookAlertsQueue.close();
}

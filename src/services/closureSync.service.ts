import mongoose from "mongoose";
import Alert from "../models/Alert";
import { updateAlertResolved } from "./MongoDBService";
import { wouldSendCeseToHelix } from "../utils/tcpSilentRules";
import { log } from "../utils/logger";

/**
 * Sincronización de cierres desde la base de OTRA instancia (la de polling).
 *
 * Por qué existe (13-oct-2026): -wh cierra sus alertas con barridos que piden
 * listas a la API de Meraki, y esa API admite una petición cada 10 s por
 * organización, compartida con mep3. Los barridos de -wh fallaban por 429 y
 * las alertas quedaban abiertas aunque Meraki ya las hubiera resuelto (277
 * colgadas en -wh contra 4 en mep3). mep3 sí tiene el estado de cierre al
 * día, y vive en la misma máquina: en vez de pagar de nuevo esa lectura a la
 * API, -wh la toma de la base de mep3. Cero llamadas a Meraki.
 *
 * Solo LEE la otra base. Cierra localmente con `updateAlertResolved` (deja la
 * alerta pendiente de envío, así el cese sigue a Epistech). Para no mandar un
 * cese duplicado a Helix -- que cierra TODAS las alarmas del equipo -- se
 * OMITEN las alertas cuyo cese saldría de esta instancia hacia Helix según
 * las reglas de silencio (ver utils/tcpSilentRules.ts): en -wh el cese hacia
 * Helix lo envía mep3.
 *
 * DEPENDENCIA: la base de mep3 solo se actualiza si mep3 SIGUE HACIENDO su
 * polling (cron de activas, de ceses y pasada por ID). Si su app se detiene,
 * esta sincronización sigue funcionando pero ya no ve cierres nuevos y las
 * alertas quedarían abiertas sin aviso. Por eso se lee su registro
 * `syncstates` (clave `cisco_cese`, que mep3 escribe en cada ciclo de ceses) y
 * se avisa si está viejo (CLOSURE_SYNC_MAX_STALE_MIN, default 30).
 *
 * Variables: CLOSURE_SYNC_MONGO_URI (obligatoria, base de la instancia
 * origen), CLOSURE_SYNC_BATCH (default 500), CLOSURE_SYNC_DRY_RUN=true (cuenta
 * lo que cerraría, sin escribir), CLOSURE_SYNC_MAX_STALE_MIN.
 */

const BATCH = parseInt(process.env.CLOSURE_SYNC_BATCH || "500", 10);
const MAX_STALE_MIN = parseInt(process.env.CLOSURE_SYNC_MAX_STALE_MIN || "30", 10);

let sourceConn: mongoose.Connection | null = null;

async function getSourceDb() {
  const uri = process.env.CLOSURE_SYNC_MONGO_URI;
  if (!uri) throw new Error("CLOSURE_SYNC_MONGO_URI no está definida");
  if (!sourceConn) {
    sourceConn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 2 });
  }
  try {
    await sourceConn.asPromise();
  } catch (err) {
    // Se descarta la conexión fallida para que la próxima corrida cree una nueva.
    const dead = sourceConn;
    sourceConn = null;
    dead.close().catch(() => undefined);
    throw err;
  }
  return sourceConn.db!;
}

export interface ClosureSyncSummary {
  open: number;
  found_in_source: number;
  not_in_source: number;
  resolved_in_source: number;
  closed: number;
  skipped_would_send_helix: number;
  failed: number;
  dry_run: boolean;
  // Minutos desde el último ciclo de ceses de la instancia origen (null si no
  // hay registro) y su último error, para detectar que dejó de hacer polling.
  source_cese_age_min: number | null;
  source_cese_error: string | null;
}

export async function runClosureSync(): Promise<ClosureSyncSummary | { skipped: true; reason: string }> {
  const local = await Alert.find({ resolvedAt: null }, { alertId: 1, type: 1, createdAt: 1, _id: 0 }).lean<
    { alertId: string; type: string; createdAt?: Date }[]
  >();
  if (local.length === 0) return { skipped: true, reason: "no_open_alerts" };

  const sourceDb = await getSourceDb();
  const source = sourceDb.collection("alerts");
  const state = await sourceDb.collection("syncstates").findOne({ key: "cisco_cese" });
  const ageMin = state?.lastSyncAt ? Math.round((Date.now() - new Date(state.lastSyncAt).getTime()) / 60000) : null;
  if (ageMin === null || ageMin > MAX_STALE_MIN) {
    log.warn("webhook_verify.closure_sync.source_stale", {
      source_cese_age_min: ageMin,
      max_stale_min: MAX_STALE_MIN,
      message: "la instancia origen no registra un ciclo de ceses reciente: puede haber dejado de hacer polling",
    });
  }
  const resolvedBy = new Map<string, string>();
  let foundInSource = 0;
  for (let i = 0; i < local.length; i += BATCH) {
    const ids = local.slice(i, i + BATCH).map((a) => a.alertId);
    const docs = await source
      .find({ alertId: { $in: ids } }, { projection: { _id: 0, alertId: 1, resolvedAt: 1 } })
      .toArray();
    for (const d of docs) {
      foundInSource++;
      if (d.resolvedAt) resolvedBy.set(String(d.alertId), String(d.resolvedAt));
    }
  }

  const dryRun = process.env.CLOSURE_SYNC_DRY_RUN === "true";
  let closed = 0;
  let wouldSend = 0;
  let failed = 0;
  for (const a of local) {
    const resolvedAt = resolvedBy.get(a.alertId);
    if (!resolvedAt) continue;
    const createdMs = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    if (wouldSendCeseToHelix(a.type, createdMs)) {
      wouldSend++;
      continue;
    }
    if (dryRun) {
      closed++;
      continue;
    }
    try {
      await updateAlertResolved(a.alertId, resolvedAt);
      closed++;
    } catch (err: any) {
      failed++;
      log.warn("webhook_verify.closure_sync.update_failed", { alertId: a.alertId, message: err?.message });
    }
  }

  return {
    open: local.length,
    found_in_source: foundInSource,
    not_in_source: local.length - foundInSource,
    resolved_in_source: resolvedBy.size,
    closed,
    skipped_would_send_helix: wouldSend,
    failed,
    dry_run: dryRun,
    source_cese_age_min: ageMin,
    source_cese_error: state?.lastError ? String(state.lastError) : null,
  };
}

import "dotenv/config";
import connectDB from "./db/mongodb";
import express from "express";
import cron from "node-cron";
import ActiveAlertsService from "./services/active.alerts.service";
import CeseAlertsService from "./services/cese.alerts.service";
import ReconciliationService from "./services/reconciliation.service";
import Alert from "./models/Alert";
import AlarmManual from "./models/AlarmManual";
import WebhookTest from "./models/WebhookTest";
import { getSyncState } from "./models/SyncState";
import { log } from "./utils/logger";
// Side-effect imports: arrancan los Workers que consumen cada cola --
// deben importarse antes de que los crons de abajo puedan encolar el
// primer job.
// - meraki.worker: gateway de llamadas a Meraki (concurrency:1 + rate-limit
//   compartido entre active/cese/reconciliation).
// - sendAlerts.worker: ciclo de envío de alertas a Helix vía ms-helix-tcp,
//   ahora trazable como job (antes se llamaba directo desde el cron).
import "./workers/meraki.worker";
import "./workers/sendAlerts.worker";
// webhookAlerts.worker: consumidor de alertas ACTIVAS recibidas por push
// desde Meraki (Fase C, en construcción -- ver 01_FIX_ALERTAS_RETENIDAS...md).
// Independiente de meraki.worker (ese es el gateway de SALIDA hacia la API
// REST de Meraki); este consume la cola de ENTRADA que llena la ruta
// POST /webhooks/meraki/alerts más abajo.
import "./workers/webhookAlerts.worker";
// webhookCeses.worker: consumidor de CESES (resolución) recibidos por push
// -- endpoint separado de webhookAlerts a propósito, ver
// queues/webhookCeses.queue.ts.
import "./workers/webhookCeses.worker";
// epistechWebhook.worker: reenvía caídas + ceses hacia EPISTECH
// (EpistechWebHook), en paralelo al envío a ms-helix-tcp -- ver
// FlowFunctions.ts (validateAndBuildAlertsToSend) y
// queues/epistechWebhook.queue.ts.
import "./workers/epistechWebhook.worker";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { merakiQueue } from "./queues/meraki.queue";
import { sendAlertsQueue, enqueueSendAlertsCycle } from "./queues/sendAlerts.queue";
import { webhookAlertsQueue, enqueueWebhookAlert } from "./queues/webhookAlerts.queue";
import { webhookCesesQueue, enqueueWebhookCese } from "./queues/webhookCeses.queue";
import { epistechWebhookQueue } from "./queues/epistechWebhook.queue";
import { bullBoardBasicAuth } from "./middleware/basicAuth";
import { merakiWebhookAuth } from "./middleware/merakiWebhookAuth";

connectDB();

let isProcessingActive = false;
let isProcessingResolved = false;
let isProcessingSending = false;
let isProcessingReconciliation = false;

const startedAt = new Date().toISOString();

cron.schedule("*/1 * * * *", async () => {
    if (isProcessingSending) return;
    isProcessingSending = true;
    const t0 = Date.now();
    try {
      await enqueueSendAlertsCycle();
      log.info("cron.send.done", { ms: Date.now() - t0 });
    } catch (err: any) {
      log.error("cron.send.error", { ms: Date.now() - t0, message: err?.message });
    } finally{
      isProcessingSending = false;
    }
});

// Flags para poder apagar el polling contra Meraki sin parar el contenedor
// entero -- pensado para desarrollo/pruebas locales (ej. probar el webhook
// receptor, Fase C) usando credenciales REALES de producción: sin esto,
// `active`/`cese` seguían corriendo cada 1-3 min contra la Meraki real
// aunque `RECONCILIATION_ENABLED=false`, compitiendo por el mismo
// rate-limit que la instancia real de producción (justo lo que la Fase D
// coordina DENTRO de un proceso, pero no puede coordinar ENTRE procesos
// distintos). Default `true` en ambos -- no cambia el comportamiento en
// producción a menos que se seteen explícitamente en `false`.
const activeEnabled = process.env.ACTIVE_ENABLED !== "false";
const ceseEnabled = process.env.CESE_ENABLED !== "false";

if (activeEnabled) {
  cron.schedule("*/1 * * * *", async () => {
     const t0 = Date.now();
     try {
      console.log("---------Active Alerts:----------");
        if (isProcessingActive) return;
        isProcessingActive = true;
      const activeAlertsService: ActiveAlertsService = new ActiveAlertsService();
      await activeAlertsService.getActiveAlerts();
      isProcessingActive = false;
      log.info("cron.active.done", { ms: Date.now() - t0 });
      } catch (err: any) {
        log.error("cron.active.error", { ms: Date.now() - t0, message: err?.message });
      } finally {
        console.log("### FINALIZADO  ACTIVAS###")
       }
  });
} else {
  log.info("cron.active.disabled");
}

if (ceseEnabled) {
cron.schedule("*/3 * * * *", async () => {
  const t0 = Date.now();
  try {
    console.log("---------Cece Alerts:----------");
      if (isProcessingResolved) return;
      isProcessingResolved = true;
      const ceseAlertService: CeseAlertsService = new CeseAlertsService();
      await ceseAlertService.getCeseAlerts();
      isProcessingResolved = false;
      log.info("cron.cese.done", { ms: Date.now() - t0 });
     } catch (err: any) {
      log.error("cron.cese.error", { ms: Date.now() - t0, message: err?.message });
     } finally {
      console.log("### FINALIZADO CESES ###")
     }
});
} else {
  log.info("cron.cese.disabled");
}

// Reconciliación de alertas huérfanas: corre el barrido por network que
// detecta y cesa las alertas resueltas en Cisco que no llegaron por el cron
// de CESE (sortBy=startedAt no las trae si tienen startedAt viejo).
// Cadencia configurable; default cada hora minuto 7.
const reconciliationSchedule = process.env.RECONCILIATION_CRON || "7 * * * *";
const reconciliationEnabled = process.env.RECONCILIATION_ENABLED !== "false";
if (reconciliationEnabled) {
  if (!cron.validate(reconciliationSchedule)) {
    log.error("cron.reconciliation.invalid_schedule", { schedule: reconciliationSchedule });
  } else {
    cron.schedule(reconciliationSchedule, async () => {
      if (isProcessingReconciliation) return;
      isProcessingReconciliation = true;
      const t0 = Date.now();
      try {
        console.log("---------Reconciliation:----------");
        const reconciliationService = new ReconciliationService();
        await reconciliationService.run();
        log.info("cron.reconciliation.done", { ms: Date.now() - t0 });
      } catch (err: any) {
        log.error("cron.reconciliation.error", { ms: Date.now() - t0, message: err?.message });
      } finally {
        isProcessingReconciliation = false;
        console.log("### FINALIZADO RECONCILIACIÓN ###");
      }
    });
    log.info("cron.reconciliation.scheduled", { schedule: reconciliationSchedule });
  }
} else {
  log.info("cron.reconciliation.disabled");
}

const app = express();
const HTTP_PORT = process.env.HTTP_PORT;

// Dashboard visual de la cola meraki-api-calls (bull-board), protegido con
// basic auth (ver src/middleware/basicAuth.ts -- "fail closed": queda
// deshabilitado si no hay BULLBOARD_USER/BULLBOARD_PASSWORD configuradas).
const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [
    new BullMQAdapter(merakiQueue),
    new BullMQAdapter(sendAlertsQueue),
    new BullMQAdapter(webhookAlertsQueue),
    new BullMQAdapter(webhookCesesQueue),
    new BullMQAdapter(epistechWebhookQueue),
  ],
  serverAdapter: bullBoardAdapter,
});
app.use("/admin/queues", bullBoardBasicAuth, bullBoardAdapter.getRouter());

// Historial liviano de pruebas enviadas desde Meraki Toolbox. Usa las
// mismas credenciales del Bull Dashboard y nunca devuelve el shared secret
// ni el body completo recibido.
app.get("/admin/webhook-tests", bullBoardBasicAuth, async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;

    const tests = await WebhookTest.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ count: tests.length, tests });
  } catch (err: any) {
    log.error("webhook_tests.list.error", { message: err?.message });
    res.status(500).json({ status: "error" });
  }
});

// Receptor de Webhooks de Meraki -- Fase C (en construcción). Por ahora
// solo recibe alertas ACTIVAS (raised); el cese/resolución queda pendiente
// de decidir si comparte este mismo endpoint o va aparte (ver
// 01_FIX_ALERTAS_RETENIDAS_2026-05-12.md, sección FASE C). `express.json()`
// scoped solo a esta ruta -- el resto del servicio no recibe bodies JSON
// hoy, no hace falta parsearlo globalmente.
app.post(
  "/webhooks/meraki/alerts",
  express.json({ limit: "1mb" }),
  merakiWebhookAuth,
  async (req, res) => {
    try {
      await enqueueWebhookAlert(req.body);
      // Responder 2xx rápido es importante: Meraki desactiva el receptor
      // si la entrega falla consistentemente por más de 100 intentos en
      // 24h (ver developer.cisco.com/meraki/webhooks/introduction/).
      res.status(200).json({ status: "queued" });
    } catch (err: any) {
      log.error("meraki_webhook.enqueue.error", { message: err?.message });
      res.status(500).json({ status: "error" });
    }
  },
);

// Endpoint separado para CESES (resolución) -- ver nota en
// queues/webhookCeses.queue.ts sobre por qué no comparte ruta con el de
// activas. Mismo shared secret / mismo patrón de respuesta rápida.
app.post(
  "/webhooks/meraki/ceses",
  express.json({ limit: "1mb" }),
  merakiWebhookAuth,
  async (req, res) => {
    try {
      await enqueueWebhookCese(req.body);
      res.status(200).json({ status: "queued" });
    } catch (err: any) {
      log.error("meraki_webhook.cese.enqueue.error", { message: err?.message });
      res.status(500).json({ status: "error" });
    }
  },
);

app.get("/health", async (_req, res) => {
  try {
    const now = Date.now();
    const cutoff1h = new Date(now - 1 * 3600 * 1000).toISOString();
    const cutoff6h = new Date(now - 6 * 3600 * 1000).toISOString();
    const cutoff24h = new Date(now - 24 * 3600 * 1000).toISOString();

    const [
      total,
      pendingTcp,
      glpiValid,
      glpiInvalid,
      resolved,
      activeRules,
      stuck1h,
      stuck6h,
      stuck24h,
      oldestStuckDoc,
      reconState,
    ] = await Promise.all([
      Alert.countDocuments({}),
      Alert.countDocuments({ isGlpi: true, isTcp: false }),
      Alert.countDocuments({ isGlpi: true }),
      Alert.countDocuments({ isGlpi: false }),
      Alert.countDocuments({ resolvedAt: { $ne: null } }),
      AlarmManual.countDocuments({ isActive: true }),
      Alert.countDocuments({ resolvedAt: null, isGlpi: true, startedAt: { $lt: cutoff1h } }),
      Alert.countDocuments({ resolvedAt: null, isGlpi: true, startedAt: { $lt: cutoff6h } }),
      Alert.countDocuments({ resolvedAt: null, isGlpi: true, startedAt: { $lt: cutoff24h } }),
      Alert.findOne({ resolvedAt: null, isGlpi: true, startedAt: { $lt: cutoff1h } })
        .sort({ startedAt: 1 })
        .select({ startedAt: 1, alertId: 1, _id: 0 })
        .lean<{ alertId: string; startedAt: string } | null>(),
      getSyncState("cisco_reconciliation"),
    ]);

    const oldestStuck = oldestStuckDoc
      ? {
          alertId: oldestStuckDoc.alertId,
          startedAt: oldestStuckDoc.startedAt,
          age_hours: Math.round(
            (now - new Date(oldestStuckDoc.startedAt).getTime()) / 3600000,
          ),
        }
      : null;

    const lastReconciliation = reconState
      ? {
          at: reconState.lastSyncAt,
          metadata: reconState.metadata ?? null,
        }
      : null;

    res.json({
      status: "ok",
      service: "ms-helix-mep",
      startedAt,
      timestamp: new Date().toISOString(),
      processing: {
        active: isProcessingActive,
        cese: isProcessingResolved,
        sending: isProcessingSending,
        reconciliation: isProcessingReconciliation,
      },
      alerts: { total, pendingTcp, glpiValid, glpiInvalid, resolved },
      catalog: { activeRules },
      drift: {
        stuck_1h: stuck1h,
        stuck_6h: stuck6h,
        stuck_24h: stuck24h,
        oldest_stuck: oldestStuck,
        last_reconciliation: lastReconciliation,
      },
    });
  } catch (err: any) {
    log.error("health.error", { message: err?.message });
    res.status(500).json({ status: "error", message: err?.message });
  }
});

app.get("/health/types", async (_req, res) => {
  try {
    const [topPending, catalogTypes] = await Promise.all([
      Alert.aggregate([
        { $match: { isTcp: false } },
        {
          $group: {
            _id: { type: "$type", productType: { $arrayElemAt: ["$scope.devices.productType", 0] } },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 30 },
      ]),
      AlarmManual.find({ isActive: true }, { type: 1, productType: 1, _id: 0 }).lean(),
    ]);
    const catalogSet = new Set(catalogTypes.map((r: any) => `${r.type}|${r.productType}`));
    const enriched = topPending.map((row: any) => ({
      type: row._id.type,
      productType: row._id.productType ?? null,
      count: row.count,
      inCatalog: catalogSet.has(`${row._id.type}|${row._id.productType}`),
    }));
    res.json({
      timestamp: new Date().toISOString(),
      catalogRules: catalogTypes.length,
      topPendingTypes: enriched,
    });
  } catch (err: any) {
    log.error("health.types.error", { message: err?.message });
    res.status(500).json({ status: "error", message: err?.message });
  }
});

app.listen(HTTP_PORT, () => {
  console.log(`Servidor HTTP escuchando en el puerto ${HTTP_PORT}`);
  log.info("server.started", { port: HTTP_PORT, startedAt });
});

import "dotenv/config";
import connectDB from "./db/mongodb";
import express from "express";
import cron from "node-cron";
import ActiveAlertsService from "./services/active.alerts.service";
import CeseAlertsService from "./services/cese.alerts.service";
import { validateAndBuildAlertsToSend } from "./functions/FlowFunctions";
import Alert from "./models/Alert";
import AlarmManual from "./models/AlarmManual";
import { log } from "./utils/logger";

connectDB();

let isProcessingActive = false;
let isProcessingResolved = false;
let isProcessingSending = false;

const startedAt = new Date().toISOString();

cron.schedule("*/1 * * * *", async () => {
    if (isProcessingSending) return;
    isProcessingSending = true;
    const t0 = Date.now();
    try {
      await validateAndBuildAlertsToSend();
      log.info("cron.send.done", { ms: Date.now() - t0 });
    } catch (err: any) {
      log.error("cron.send.error", { ms: Date.now() - t0, message: err?.message });
    } finally{
      isProcessingSending = false;
    }
});

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

const app = express();
const HTTP_PORT = process.env.HTTP_PORT;

app.get("/health", async (_req, res) => {
  try {
    const [total, pendingTcp, glpiValid, glpiInvalid, resolved, activeRules] = await Promise.all([
      Alert.countDocuments({}),
      Alert.countDocuments({ isGlpi: true, isTcp: false }),
      Alert.countDocuments({ isGlpi: true }),
      Alert.countDocuments({ isGlpi: false }),
      Alert.countDocuments({ resolvedAt: { $ne: null } }),
      AlarmManual.countDocuments({ isActive: true }),
    ]);
    res.json({
      status: "ok",
      service: "ms-helix-mep",
      startedAt,
      timestamp: new Date().toISOString(),
      processing: {
        active: isProcessingActive,
        cese: isProcessingResolved,
        sending: isProcessingSending,
      },
      alerts: { total, pendingTcp, glpiValid, glpiInvalid, resolved },
      catalog: { activeRules },
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

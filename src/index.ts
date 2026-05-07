import "dotenv/config";
import connectDB from "./db/mongodb";
import express from "express";
import cron from "node-cron";
// import {
//   getAndSaveActiveAlerts,
//   getAndSetResolvedAlerts,
//   validateAndBuildAlertsToSend,
// } from "./functions/FlowFunctions";
import ActiveAlertsService from "./services/active.alerts.service";
import CeseAlertsService from "./services/cese.alerts.service";
import { validateAndBuildAlertsToSend } from "./functions/FlowFunctions";

connectDB();

let isProcessingActive = false;
let isProcessingResolved = false;
let isProcessingSending = false;

// Emisión TCP (Cada 30 segundos)
cron.schedule("*/1 * * * *", async () => {
    if (isProcessingSending) return;
    isProcessingSending = true;
    try {
      await validateAndBuildAlertsToSend();
    } finally{
      isProcessingSending = false;
    }
});

cron.schedule("*/1 * * * *", async () => {
   try {
    console.log("---------Active Alerts:----------");
      if (isProcessingActive) return; 
      isProcessingActive = true;
    const activeAlertsService: ActiveAlertsService = new ActiveAlertsService();
    await activeAlertsService.getActiveAlerts();
    isProcessingActive = false;
    } finally {
      console.log("### FINALIZADO  ACTIVAS###")
     }
});

cron.schedule("*/3 * * * *", async () => {
  try {
    console.log("---------Cece Alerts:----------");
      if (isProcessingResolved) return; 
      isProcessingResolved = true;
      const ceseAlertService: CeseAlertsService = new CeseAlertsService();
      await ceseAlertService.getCeseAlerts();
      isProcessingResolved = false;
     } finally {
      console.log("### FINALIZADO CESES ###")
     }
});

const app = express();
const HTTP_PORT = process.env.HTTP_PORT;

app.listen(HTTP_PORT, () => {
  console.log(`Servidor HTTP escuchando en el puerto ${HTTP_PORT}`);
});
import dotenv from "dotenv";
dotenv.config();
import connectDB from "./db/mongodb";
import express from "express";
import cron from "node-cron";
import {
  getAndSaveActiveAlerts,
  getAndSetResolvedAlerts,
  validateAndBuildAlertsToSend,
} from "./functions/FlowFunctions";

connectDB();

cron.schedule("* * * * *", () => {
  getAndSaveActiveAlerts();
});

cron.schedule("* * * * *", () => {
  validateAndBuildAlertsToSend();
});

cron.schedule("* * * * *", () => {
  getAndSetResolvedAlerts();
});

// -------------------
// Servidor HTTP
// -------------------
const app = express();
const HTTP_PORT = process.env.HTTP_PORT;

app.listen(HTTP_PORT, () => {
  console.log(`Servidor HTTP escuchando en el puerto ${HTTP_PORT}`);
});

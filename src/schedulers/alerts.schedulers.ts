// import { alertsQueue } from "../queues/alerts.queue.js";
// import dotenv from "dotenv";

// dotenv.config();

// const FETCH_ACTIVE_INTERVAL = 360000; // 6 min
// const FETCH_RESOLVED_INTERVAL = 240000; // 4 min
// const SEND_ALERTS_INTERVAL = 30000; // 30s

// /**
//  * Inicia los schedulers para las diferentes tareas
//  */
// export function startSchedulers() {
//   console.log("⏰ Iniciando schedulers...");

//   // Scheduler para alertas activas (cada 6 minutos)
//   setInterval(() => {
//     alertsQueue.add(
//       "fetch-active",
//       {},
//       {
//         jobId: "fetch-active-" + Date.now(), // Evita duplicados con timestamp
//         removeOnComplete: true,
//       }
//     );
//     console.log("📅 Job 'fetch-active' programado");
//   }, FETCH_ACTIVE_INTERVAL);

//   // Scheduler para alertas resueltas (cada 4 minutos)
//   setInterval(() => {
//     alertsQueue.add(
//       "fetch-resolved",
//       {},
//       {
//         jobId: "fetch-resolved-" + Date.now(),
//         removeOnComplete: true,
//       }
//     );
//     console.log("📅 Job 'fetch-resolved' programado");
//   }, FETCH_RESOLVED_INTERVAL);

//   // Scheduler para envío de alertas (cada 30 segundos)
//   setInterval(() => {
//     alertsQueue.add(
//       "send-alerts",
//       {},
//       {
//         jobId: "send-alerts-" + Date.now(),
//         removeOnComplete: true,
//       }
//     );
//     console.log("📅 Job 'send-alerts' programado");
//   }, SEND_ALERTS_INTERVAL);

//   // Ejecutar inmediatamente el primer ciclo
//   alertsQueue.add("fetch-active", {}, { jobId: "fetch-active-initial" });
//   alertsQueue.add("fetch-resolved", {}, { jobId: "fetch-resolved-initial" });
//   alertsQueue.add("send-alerts", {}, { jobId: "send-alerts-initial" });

//   console.log("✅ Schedulers iniciados correctamente");
//   console.log(`   - Fetch Active: cada ${FETCH_ACTIVE_INTERVAL / 1000}s`);
//   console.log(`   - Fetch Resolved: cada ${FETCH_RESOLVED_INTERVAL / 1000}s`);
//   console.log(`   - Send Alerts: cada ${SEND_ALERTS_INTERVAL / 1000}s`);
// }

// import { Queue } from "bullmq";
// import { connection } from "../config/redis.js";

// export const alertsQueue = new Queue("alerts-queue", {
//   connection,
//   defaultJobOptions: {
//     attempts: 3,
//     backoff: {
//       type: "exponential",
//       delay: 5000,
//     },
//     removeOnComplete: {
//       count: 100, // Mantener últimos 100 completados
//       age: 3600, // Eliminar después de 1 hora
//     },
//     removeOnFail: {
//       count: 500, // Mantener últimos 500 fallidos para debugging
//     },
//   },
// });

// alertsQueue.on("error", (err) => {
//   console.error("❌ Error en la cola:", err);
// });

// console.log("📦 Cola de alertas inicializada");


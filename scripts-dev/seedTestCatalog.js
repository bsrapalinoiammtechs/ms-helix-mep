/**
 * Siembra reglas de prueba en AlarmManual para poder probar el flujo
 * completo (catálogo -> GLPI -> guardado) en un Mongo local vacío.
 *
 * NO es el catálogo real de producción -- eso lo administra el equipo a
 * mano. Es solo para no quedar bloqueado en "not_in_catalog" al probar
 * el webhook localmente. Idempotente (upsert), se puede correr varias
 * veces sin duplicar.
 *
 * Uso: docker exec ms-helix-mep node scripts-dev/seedTestCatalog.js
 * (requiere que este archivo esté copiado dentro del contenedor, ver
 * instrucciones en el chat)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const rules = [
  {
    type: "Connectivity",
    productType: "wireless",
    categoryType: "Connectivity",
    isActive: true,
    elementType: "Conectividad",
    title: "Dispositivo fuera de línea",
    severityHelix: "ALTO",
  },
  {
    type: "gateway_down",
    productType: "appliance",
    categoryType: "Connectivity",
    isActive: true,
    elementType: "Conectividad",
    title: "Gateway caído",
    severityHelix: "ALTO",
  },
  {
    type: "device_health",
    productType: "wireless",
    categoryType: "device_health",
    isActive: true,
    elementType: "Degradacion velocidad conexion",
    title: "Degradación de velocidad de conexión",
    severityHelix: "MEDIO",
  },
];

async function main() {
  await mongoose.connect(process.env.MONGO_DB);
  const db = mongoose.connection.db;

  for (const rule of rules) {
    await db.collection("alarmmanuals").updateOne(
      { type: rule.type, productType: rule.productType },
      { $set: rule },
      { upsert: true },
    );
    console.log(`OK: ${rule.type} | ${rule.productType}`);
  }

  console.log(`\n${rules.length} reglas de prueba sembradas/actualizadas.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

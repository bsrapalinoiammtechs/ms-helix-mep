/**
 * Patrón compartido para identificar redes de "estacionamiento" (RMA/pruebas)
 * -- no son escuelas reales, son equipos en tránsito por reemplazo de
 * hardware. Compartido entre dos puntos:
 *
 * 1. `staleAlertCleanup.service.ts`: cierra alertas viejas que viven ahí.
 * 2. `active.alerts.service.ts`: IGNORA por completo cualquier alerta de
 *    esas redes al pullear -- crítico, sin esto el pulleo normal revive en
 *    <1 minuto cualquier alerta que el punto 1 haya cerrado, porque Meraki
 *    genuinamente sigue reportando esos equipos como activos para siempre
 *    (nunca se reconectan). Ver hallazgo real 30-sep-2026: 15 alertas de
 *    Meraki en `SAMEP-PRUEBAS-RMA`/`RMAs` cerradas por la limpieza y
 *    revividas por el pulleo activo dentro del mismo minuto.
 */

const RAW_PATTERNS = process.env.STALE_ALERT_NETWORK_PATTERNS || "PRUEBAS,RMA";

const PATTERNS = RAW_PATTERNS.split(",")
  .map((p) => p.trim().toUpperCase())
  .filter(Boolean);

export function isStaleNetworkName(networkName?: string | null): boolean {
  if (!networkName) return false;
  const upper = networkName.toUpperCase();
  return PATTERNS.some((p) => upper.includes(p));
}

export function getStaleNetworkPatterns(): string[] {
  return PATTERNS;
}

import { log } from "./logger";
import { parseAlertTypes } from "./alertTypes";

/**
 * Reglas de silencio del envío a Helix (ver FlowFunctions.validateAndBuildAlertsToSend).
 * Viven aquí, sin dependencias pesadas, para poder evaluarlas también desde
 * otros servicios (closureSync) y probarlas aisladas.
 */

/**
 * Silencio por tipo (respaldo): TCP_SILENT_TYPES (lista separada por comas) +
 * TCP_SILENT_FROM (ISO, hora de ESTE servidor). Las alertas de esos tipos
 * CREADAS desde TCP_SILENT_FROM se procesan y guardan normalmente, pero no se
 * envían a Helix ni a Epistech: se marcan como enviadas sin enviar. Sirve
 * para dejar el polling corriendo como respaldo de un tipo que ya llega por
 * webhook por otra instancia, sin duplicar alertas.
 *
 * La fecha de corte es obligatoria a propósito: las alertas anteriores ya
 * están en Helix, y su cese (que sale por este mismo ciclo) tiene que seguir
 * enviándose. La clasificación depende solo de (tipo, createdAt), así que el
 * cese de una alerta silenciada también queda silenciado. Sin
 * TCP_SILENT_FROM válido no se silencia nada (falla hacia enviar).
 */
export function getSilentRule(): { types: string[]; fromMs: number; keepCese: boolean } | null {
  const types = parseAlertTypes(process.env.TCP_SILENT_TYPES);
  if (!types) return null;
  const fromMs = Date.parse(process.env.TCP_SILENT_FROM || "");
  if (Number.isNaN(fromMs)) {
    log.error("send.silent.invalid_from", {
      message: "TCP_SILENT_TYPES definido sin TCP_SILENT_FROM válido (ISO) -- no se silencia nada",
    });
    return null;
  }
  // TCP_SILENT_KEEP_CESE=true: se silencia la ALARMA pero el CESE sí se envía.
  // Reparto de funciones entre instancias: una detecta y envía la alarma, la
  // otra (la que tiene el cese al día) envía el cese. Helix cierra TODAS las
  // alarmas del equipo con un solo cese, así que el cese debe salir una vez y
  // desde quien lo ve de forma fiable.
  return { types, fromMs, keepCese: process.env.TCP_SILENT_KEEP_CESE === "true" };
}

/**
 * Silencio de CESES hacia Helix: TCP_SILENT_CESE_TYPES (lista) +
 * TCP_SILENT_CESE_BEFORE (ISO, hora de ESTE servidor). El cese de una alerta
 * de esos tipos CREADA antes de esa fecha no se envía a Helix (sí a Epistech,
 * que es idempotente por alert_id). Para la instancia -wh: las alertas
 * anteriores al corte las gestiona producción, y Helix identifica la alarma
 * por nombre de equipo, así que un cese repetido que llegue tarde podría
 * cerrar una alarma NUEVA del mismo equipo. Sin ambas variables válidas no
 * se silencia nada.
 */
export function getSilentCeseRule(): { types: string[]; beforeMs: number } | null {
  const types = parseAlertTypes(process.env.TCP_SILENT_CESE_TYPES);
  if (!types) return null;
  const beforeMs = Date.parse(process.env.TCP_SILENT_CESE_BEFORE || "");
  if (Number.isNaN(beforeMs)) {
    log.error("send.silent_cese.invalid_before", {
      message: "TCP_SILENT_CESE_TYPES definido sin TCP_SILENT_CESE_BEFORE válido (ISO) -- no se silencia nada",
    });
    return null;
  }
  return { types, beforeMs };
}

/**
 * ¿El CESE de una alerta (tipo, createdAt) saldría de esta instancia hacia
 * Helix? Replica, para un pendiente YA resuelto, las mismas reglas que
 * aplica el ciclo de envío. false si TCP_ENABLED=false (la instancia no toca
 * Helix), si la regla de alarma lo silencia por completo, o si la regla de
 * ceses lo omite del envío TCP.
 */
export function wouldSendCeseToHelix(type: string, createdAtMs: number): boolean {
  if (process.env.TCP_ENABLED === "false") return false;
  const silent = getSilentRule();
  if (silent && silent.types.includes(type) && createdAtMs >= silent.fromMs && !silent.keepCese) {
    return false;
  }
  const cese = getSilentCeseRule();
  if (cese && cese.types.includes(type) && createdAtMs < cese.beforeMs) {
    return false;
  }
  return true;
}

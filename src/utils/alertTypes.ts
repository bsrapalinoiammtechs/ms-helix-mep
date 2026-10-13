/**
 * Lee una lista de tipos separada por comas desde una variable de entorno
 * (ej. "crc_errors,dns_down") y la normaliza. Vacío o sin definir => undefined,
 * o sea sin filtro por tipo.
 *
 * Vive en utils (sin dependencias) para poder usarla y probarla sin arrastrar
 * las colas de BullMQ; cisco.alerts.service la reexporta.
 */
export function parseAlertTypes(raw: string | undefined): string[] | undefined {
  const types = (raw || "").split(",").map((t) => t.trim()).filter(Boolean);
  return types.length > 0 ? types : undefined;
}

/**
 * Limpieza del comentario de GLPI antes de enviarlo a Helix.
 *
 * Los servicios de aprovisionamiento escriben marcas de sincronizacion en el
 * campo `comment` de GLPI; ms-cramer deja ahi
 *   "[Cramer] OK <fecha> - Nodo creado en Cramer"
 * Es contabilidad interna del aprovisionamiento: no significa nada para quien
 * opera Helix y no debe viajar en la descripcion de la alarma.
 *
 * Se filtra por patron en lugar de descartar el campo entero, para que un
 * comentario legitimo -una nota de un tecnico, o el aviso de que el equipo no
 * se encontro en GLPI- siga llegando.
 */
const COMENTARIO_INTERNO = /^\s*\[(cramer|glpi)\]/i;

export const limpiarComentario = (comentario?: string | null): string => {
  const c = (comentario ?? "").toString().trim();
  if (!c || COMENTARIO_INTERNO.test(c)) return "";
  return c;
};

/**
 * Arma DescripcionEvento uniendo solo las partes con contenido. Antes se
 * concatenaba un " - " fijo al final, asi que un equipo sin comentario en GLPI
 * producia una descripcion terminada en un separador suelto.
 */
export const armarDescripcion = (
  tipo?: string | null,
  categoria?: string | null,
  comentario?: string | null
): string =>
  [tipo, categoria, limpiarComentario(comentario)]
    .map((p) => (p ?? "").toString().trim())
    .filter((p) => p !== "")
    .join(" - ");

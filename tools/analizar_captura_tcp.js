#!/usr/bin/env node
// Uso: node tools/analizar_captura_tcp.js <antes.txt> <despues.txt> [--salida <carpeta>] [--top N]
// Lee capturas del Packet Sender (envío a Helix) y compara la sincronización REQ_ACT_ALM.
// Solo lectura. Helix identifica la alarma por NombreEquipo, por eso esa es la clave de comparación.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const outDir = flag("--salida");
const TOP = parseInt(flag("--top") || "12", 10);
const [fileBefore, fileAfter] = args;
if (!fileBefore || !fileAfter) {
  console.error("Uso: node tools/analizar_captura_tcp.js <antes.txt> <despues.txt> [--salida <carpeta>] [--top N]");
  process.exit(1);
}

function parse(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const alerts = [];
  const markers = [];
  let cur = null;
  let seq = 0;
  let inSync = false;
  let synced = false;
  for (const raw of lines) {
    const l = raw.trim();
    // Los marcadores pueden venir dentro de un bloque <+++> ... <---> sin campos, así que se detectan primero.
    if (l === "REQ_ACT_ALM") { markers.push({ tipo: l, despuesDeAlertas: seq }); continue; }
    if (l === "BEGIN ACT ALM") { inSync = true; markers.push({ tipo: l, despuesDeAlertas: seq }); continue; }
    if (l === "END ACT ALM") { inSync = false; synced = true; markers.push({ tipo: l, despuesDeAlertas: seq }); continue; }
    if (/^HEARTBEAT/.test(l)) { markers.push({ tipo: "HEARTBEAT", texto: l, despuesDeAlertas: seq }); continue; }
    if (l === "<+++>") { cur = {}; continue; }
    if (l === "<--->") {
      if (cur && cur.IdNotificacion) {
        cur._seq = seq++;
        cur._seccion = inSync ? "sync" : synced ? "posterior" : "previa";
        alerts.push(cur);
      }
      cur = null;
      continue;
    }
    if (cur) {
      const m = /^([A-Za-z-]+)\s*=\s*(.*)$/.exec(l);
      if (m) cur[m[1]] = m[2];
    }
  }
  return { file, alerts, markers };
}

const parseFecha = (a) => {
  const m = /^(\d\d)-(\d\d)-(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(a["Fecha-Hora"] || "");
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) : NaN;
};
const tally = (arr, f) => {
  const c = new Map();
  arr.forEach((x) => c.set(f(x), (c.get(f(x)) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
};
const fmt = (pairs, n = 99) => pairs.slice(0, n).map(([k, v]) => `${k}:${v}`).join("  ");
const esCese = (a) => a.SeveridadEvento === "CESE";
const edadBucket = (ms) => {
  const h = ms / 3600000;
  if (h < 1) return "a) <1h";
  if (h < 6) return "b) 1-6h";
  if (h < 24) return "c) 6-24h";
  if (h < 72) return "d) 1-3d";
  if (h < 168) return "e) 3-7d";
  if (h < 720) return "f) 7-30d";
  return "g) >30d";
};
const linea = (a) =>
  `${a["Fecha-Hora"]} | ${a.SeveridadEvento} | ${a.Evento} | ${a.NombreEquipo} | ${a.IdNotificacion} | ${(a.NombreCliente || "").slice(0, 14)}`;

function reporte(cap, etiqueta) {
  const { alerts, markers } = cap;
  const sync = alerts.filter((a) => a._seccion === "sync");
  const previa = alerts.filter((a) => a._seccion === "previa");
  const post = alerts.filter((a) => a._seccion === "posterior");
  console.log(`\n================ ${etiqueta}: ${path.basename(cap.file)}`);
  console.log(`bloques totales: ${alerts.length} | sync (entre BEGIN y END): ${sync.length} | previos: ${previa.length} | posteriores a END: ${post.length}`);
  console.log(`marcadores: ${markers.map((m) => `${m.tipo}${m.texto ? "(" + m.texto.replace("HEARTBEAT ", "") + ")" : ""}@${m.despuesDeAlertas}`).join("  ")}`);

  console.log(`\n-- Sincronización (${sync.length})`);
  console.log(`clientes:  ${fmt(tally(sync, (a) => a.NombreCliente))}`);
  console.log(`severidad: ${fmt(tally(sync, (a) => a.SeveridadEvento))}`);
  console.log(`evento:    ${fmt(tally(sync, (a) => a.Evento), 8)}`);
  const ces = sync.filter(esCese);
  console.log(`CESE dentro de la sincronización (no deberían ir en una lista de ACTIVAS): ${ces.length}`);
  ces.slice(0, TOP).forEach((a) => console.log("   ", linea(a)));

  const fechas = sync.map(parseFecha).filter((x) => !Number.isNaN(x));
  if (fechas.length) {
    const ref = Math.max(...fechas);
    console.log(`antigüedad (respecto a la alarma más reciente ${new Date(ref).toISOString().slice(0, 16)}): ${fmt(tally(sync.filter((a) => !Number.isNaN(parseFecha(a))), (a) => edadBucket(ref - parseFecha(a))).sort())}`);
  }

  const dupId = tally(sync, (a) => a.IdNotificacion).filter(([, n]) => n > 1);
  console.log(`IdNotificacion repetido en la sync: ${dupId.length}${dupId.length ? "  " + fmt(dupId, 6) : ""}`);
  const porEquipo = new Map();
  sync.filter((a) => !esCese(a)).forEach((a) => porEquipo.set(a.NombreEquipo, (porEquipo.get(a.NombreEquipo) || []).concat(a)));
  const multi = [...porEquipo.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
  console.log(`equipos con MÁS DE UNA alarma activa (Helix los identifica por nombre): ${multi.length} de ${porEquipo.size}`);
  multi.slice(0, TOP).forEach(([n, v]) => console.log(`   ${n}  x${v.length}: ${v.map((a) => `${a.Evento}@${a["Fecha-Hora"].slice(0, 10)}`).join(" ; ").slice(0, 150)}`));

  if (previa.length + post.length) {
    const live = [...previa, ...post];
    console.log(`\n-- Fuera de la sincronización (${live.length}): creaciones ${live.filter((a) => !esCese(a)).length}, ceses ${live.filter(esCese).length}`);
    console.log(`clientes: ${fmt(tally(live, (a) => a.NombreCliente))}`);
    const dupLive = tally(live, (a) => `${a.IdNotificacion}|${a.SeveridadEvento}|${a["Fecha-Hora"]}`).filter(([, n]) => n > 1);
    console.log(`mensajes IDÉNTICOS repetidos (mismo id, estado y fecha): ${dupLive.length}`);
    dupLive.slice(0, TOP).forEach(([k, n]) => console.log(`   x${n} ${k}`));
    const nuevos = live.filter((a) => !esCese(a));
    console.log(`creaciones fuera de la sync, por equipo repetidas: ${tally(nuevos, (a) => a.NombreEquipo).filter(([, n]) => n > 1).length}`);
  }
  return { sync, live: [...previa, ...post] };
}

const A = parse(fileBefore);
const B = parse(fileAfter);
const ra = reporte(A, "ANTES de REQ_ACT_ALM");
const rb = reporte(B, "DESPUÉS de REQ_ACT_ALM");

console.log("\n================ COMPARACIÓN de las sincronizaciones (antes -> después)");
const activas = (s) => s.filter((a) => !esCese(a));
const keyDev = (a) => `${a.NombreEquipo}|${a.Evento}`;
const idsA = new Set(ra.sync.map((a) => a.IdNotificacion));
const idsB = new Set(rb.sync.map((a) => a.IdNotificacion));
const soloA = ra.sync.filter((a) => !idsB.has(a.IdNotificacion));
const soloB = rb.sync.filter((a) => !idsA.has(a.IdNotificacion));
console.log(`por IdNotificacion -> antes ${idsA.size}, después ${idsB.size}, comunes ${[...idsA].filter((i) => idsB.has(i)).length}, desaparecen ${soloA.length}, aparecen ${soloB.length}`);

const devA = new Set(activas(ra.sync).map(keyDev));
const devB = new Set(activas(rb.sync).map(keyDev));
const devSoloA = [...devA].filter((k) => !devB.has(k));
const devSoloB = [...devB].filter((k) => !devA.has(k));
console.log(`por equipo+evento (solo activas) -> antes ${devA.size}, después ${devB.size}, desaparecen ${devSoloA.length}, aparecen ${devSoloB.length}`);

const posteriores = [...ra.live, ...rb.live];
const ceseIds = new Set(posteriores.filter(esCese).map((a) => a.IdNotificacion));
const ceseDev = new Set(posteriores.filter(esCese).map(keyDev));
console.log(`\nDesaparecen de la sync: ${soloA.length}. Clientes: ${fmt(tally(soloA, (a) => a.NombreCliente))}`);
console.log(`   de ellas, con un CESE visible fuera de la sync (mismo id): ${soloA.filter((a) => ceseIds.has(a.IdNotificacion)).length}; (mismo equipo+evento): ${soloA.filter((a) => ceseDev.has(keyDev(a))).length}`);
soloA.slice(0, TOP).forEach((a) => console.log("   ", linea(a)));
console.log(`\nAparecen en la sync nueva: ${soloB.length}. Clientes: ${fmt(tally(soloB, (a) => a.NombreCliente))}`);
soloB.slice(0, TOP).forEach((a) => console.log("   ", linea(a)));

// Equipo+evento presente en ambas syncs pero con conjuntos de IDs totalmente distintos: la alarma "fue reemplazada" por otra.
const idsPorDev = (s) => {
  const m = new Map();
  activas(s).forEach((a) => m.set(keyDev(a), (m.get(keyDev(a)) || new Set()).add(a.IdNotificacion)));
  return m;
};
const mA = idsPorDev(ra.sync);
const mB = idsPorDev(rb.sync);
const reemplazadas = [...mA.keys()].filter((k) => mB.has(k) && ![...mA.get(k)].some((i) => mB.get(k).has(i)));
console.log(`\nEquipo+evento en ambas syncs pero con IDs completamente distintos (alarma reemplazada): ${reemplazadas.length}`);
reemplazadas.slice(0, TOP).forEach((k) => console.log(`   ${k}: ${[...mA.get(k)].join(",")} -> ${[...mB.get(k)].join(",")}`));

// Clave de Helix = nombre del equipo: equipos con alarmas activas de EVENTOS DISTINTOS a la vez (un cese podría cerrar la otra).
function cruces(sync, etiqueta) {
  const m = new Map();
  activas(sync).forEach((a) => m.set(a.NombreEquipo, (m.get(a.NombreEquipo) || new Map()).set(a.Evento, (m.get(a.NombreEquipo)?.get(a.Evento) || 0) + 1)));
  const multi = [...m.entries()].filter(([, ev]) => ev.size > 1);
  console.log(`\n${etiqueta}: equipos con alarmas activas de EVENTOS DISTINTOS simultáneas: ${multi.length} de ${m.size}`);
  multi.slice(0, TOP).forEach(([n, ev]) => console.log(`   ${n}: ${[...ev.entries()].map(([e, c]) => `${e}${c > 1 ? " x" + c : ""}`).join(" + ")}`));
}
cruces(ra.sync, "sync ANTES");
cruces(rb.sync, "sync DESPUÉS");

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const csv = (rows) => ["Fecha-Hora;Severidad;Evento;Equipo;IdNotificacion;Cliente", ...rows.map((a) => [a["Fecha-Hora"], a.SeveridadEvento, a.Evento, a.NombreEquipo, a.IdNotificacion, a.NombreCliente].join(";"))].join("\n");
  fs.writeFileSync(path.join(outDir, "desaparecen_en_sync.csv"), csv(soloA));
  fs.writeFileSync(path.join(outDir, "aparecen_en_sync.csv"), csv(soloB));
  fs.writeFileSync(path.join(outDir, "sync_antes.csv"), csv(ra.sync));
  fs.writeFileSync(path.join(outDir, "sync_despues.csv"), csv(rb.sync));
  console.log(`\nCSV escritos en ${path.resolve(outDir)}`);
}

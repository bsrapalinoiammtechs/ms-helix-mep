#!/usr/bin/env python3
"""
Copia el ESTADO VIGENTE de mep3 a -wh antes de que -wh asuma todo el polling
(corte "forma A", 13-oct-2026): las alertas ABIERTAS (resolvedAt:null) de mep3 y
las CERRADAS de los últimos N días (--dias-cerradas, default 5) que -wh todavía
no tiene. Sin más historial.

Por qué las ABIERTAS: -wh, al empezar a hacer polling, trataría como NUEVAS las
alertas que mep3 ya mandó a Helix y reenviaría sus alarmas (Helix identifica por
nombre de equipo). Con la copia llegan a -wh con su estado de envío (isTcp:true)
y -wh solo manda su cese cuando se resuelvan. Las abiertas SIN GLPI también se
copian (isGlpi:false, nunca se envían) para que -wh no las redescubra y las
valide una por una en GLPI.

Por qué las CERRADAS RECIENTES: el polling de ceses decide qué es "nuevo"
mirando su PROPIA base: toda alerta resuelta en Meraki que no encuentra ahí la
guarda como cese y la ENVÍA a Helix. Sin historial, -wh trataría como nuevas
hasta ~6,000 resueltas (20 páginas de 300) y mandaría ceses duplicados; como un
cese cierra TODAS las alarmas del equipo en Helix, podrían cerrar alarmas
vigentes. Copiarlas como ya cesadas (isTcp:true) evita ese diluvio.

NUNCA pisa un documento que -wh ya tenga (usa $setOnInsert por alertId).
Solo LEE la base de mep3.

Guardas al aplicar:
  - la app de mep3 debe estar PARADA (si no, sus alertas cambian durante la copia);
  - mep3 no debe tener alertas de GLPI pendientes de envío (isTcp:false), o -wh
    las trataría como pendientes y las enviaría por segunda vez.

Uso (en el servidor):
  python3 migrar_estado_a_wh.py              # PRUEBA: cuenta, no escribe
  python3 migrar_estado_a_wh.py --aplicar    # copia
  python3 migrar_estado_a_wh.py --revertir   # borra de -wh lo que insertó esta copia
Respaldo de lo insertado: /tmp/migracion_estado_insertados.json
"""
import datetime
import json
import re
import subprocess
import sys
from collections import Counter

M3 = ("mongodb-helix-mep", "ms_helix_mep", "ms-helix-mep")
WH = ("mongodb-helix-mep-wh", "ms_helix_mep-wh", "ms-helix-mep-wh")
INSERTADOS = "/tmp/migracion_estado_insertados.json"
DIAS_CERRADAS = int(sys.argv[sys.argv.index("--dias-cerradas") + 1]) if "--dias-cerradas" in sys.argv else 5
LOTE = 1000   # documentos por escritura en -wh
APLICAR = "--aplicar" in sys.argv
REVERTIR = "--revertir" in sys.argv


def mongo(inst, js):
    """Ejecuta JS en mongosh de esa instancia con --file (sin indicador interactivo).
    El script se escribe dentro del contenedor por stdin, así no hay límite de argumentos."""
    cont, db, _ = inst
    ruta = "/tmp/_migracion_estado.js"
    w = subprocess.run(["docker", "exec", "-i", cont, "sh", "-c", f"cat > {ruta}"], input=js, capture_output=True, text=True)
    if w.returncode != 0:
        sys.exit(f"ERROR escribiendo el script en {cont}: {w.stderr[:300]}")
    try:
        p = subprocess.run(
            ["docker", "exec", cont, "mongosh", f"mongodb://andrair:1234@localhost:27017/{db}?authSource=admin", "--quiet", "--file", ruta],
            capture_output=True, text=True,
        )
    finally:
        subprocess.run(["docker", "exec", cont, "rm", "-f", ruta], capture_output=True)
    if p.returncode != 0:
        sys.exit(f"ERROR ejecutando en {cont}: {p.stderr[:300]}")
    return p.stdout


def ultima_salida(out):
    """Última línea que parece salida de datos (JSON o número); mongosh por stdin puede añadir líneas sueltas."""
    for linea in reversed(out.strip().splitlines()):
        l = re.sub(r"^[\w.\-]+>\s*", "", linea.strip())
        if l and (l[0] in "[{" or l.isdigit()):
            return l
    sys.exit(f"ERROR: no se encontró salida utilizable de mongosh: {out[-300:]}")


def app_corriendo(inst):
    out = subprocess.run(["docker", "ps", "--filter", f"name=^{inst[2]}$", "--format", "{{.Status}}"], capture_output=True, text=True).stdout.strip()
    return out.startswith("Up")


def preparar(docs, ya_en_wh):
    """Devuelve (a_insertar, resumen). Quita _id y alertId del cuerpo ($setOnInsert),
    y conserva todo lo demás (incluido isTcp/isGlpi) sin reinterpretarlo."""
    a_insertar = []
    for d in docs:
        if d.get("alertId") in ya_en_wh:
            continue
        cuerpo = {k: v for k, v in d.items() if k not in ("_id", "alertId")}
        a_insertar.append({"alertId": d["alertId"], "cuerpo": cuerpo})
    return a_insertar


def pendientes_de_envio(docs):
    """Abiertas de GLPI que mep3 aún no envió: -wh las mandaría de nuevo."""
    return [d["alertId"] for d in docs if d.get("isGlpi") is True and d.get("isTcp") is False]


def revertir():
    ids = json.load(open(INSERTADOS))
    print(f"revertir: {len(ids)} alertas insertadas por la copia")
    if not APLICAR:
        return print("PRUEBA: no se borró nada. Repite con --revertir --aplicar.")
    out = mongo(WH, f"const ids={json.dumps(ids)}; print(db.alerts.deleteMany({{alertId:{{$in:ids}}}}).deletedCount)")
    print("borradas de -wh:", ultima_salida(out))


def main():
    if REVERTIR:
        return revertir()
    corte = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DIAS_CERRADAS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"leyendo de mep3 las abiertas y las cerradas desde {corte} ({DIAS_CERRADAS} días)...", flush=True)
    consulta = '{$or:[{resolvedAt:null},{resolvedAt:{$gte:"%s"}}]}' % corte
    txt = ultima_salida(mongo(M3, "print(EJSON.stringify(db.alerts.find(%s).toArray(), {relaxed:true}))" % consulta))
    docs = json.loads(txt)
    ids = [d["alertId"] for d in docs]
    ya = set(json.loads(ultima_salida(mongo(WH, f"const ids={json.dumps(ids)}; print(JSON.stringify(db.alerts.find({{alertId:{{$in:ids}}}},{{_id:0,alertId:1}}).toArray().map(a=>a.alertId)))"))))
    nuevos = preparar(docs, ya)
    pend = pendientes_de_envio(docs)
    nd = {d["alertId"]: d for d in docs}
    n_ab = sum(1 for d in docs if not d.get("resolvedAt"))
    print(f"en mep3: {len(docs)} (abiertas {n_ab} + cerradas recientes {len(docs) - n_ab}) | ya están en -wh (no se tocan): {len(ya)} | a copiar: {len(nuevos)}")
    print("  a copiar por estado:", dict(Counter("abierta" if not nd[n['alertId']].get("resolvedAt") else "cerrada" for n in nuevos)))
    print("  a copiar por GLPI/envío:", dict(Counter(("glpi" if nd[n['alertId']].get("isGlpi") else "sin_glpi") + ("/enviada" if nd[n['alertId']].get("isTcp") else "/no_enviada") for n in nuevos)))
    print("  a copiar por tipo:", dict(Counter(nd[n['alertId']].get("type") for n in nuevos)))
    print(f"mep3: alertas de GLPI con envío pendiente (isTcp:false, abiertas o cerradas): {len(pend)}", "-> DEBE SER 0 para aplicar" if pend else "")
    if not APLICAR:
        return print("\nPRUEBA: no se escribió nada. Repite con --aplicar (con la app de mep3 parada).")
    if app_corriendo(M3):
        sys.exit("ABORTADO: la app de mep3 sigue corriendo; páralas antes de copiar (docker compose stop ms-helix en su carpeta).")
    if pend:
        sys.exit("ABORTADO: mep3 tiene alertas de GLPI sin enviar; espera a que termine su ciclo de envío y repite.")
    if not nuevos:
        return print("nada que copiar.")
    json.dump([n["alertId"] for n in nuevos], open(INSERTADOS, "w"))
    total = {"insertadas": 0, "ya_existian": 0}
    for i in range(0, len(nuevos), LOTE):
        lote = nuevos[i:i + LOTE]
        cuerpo = json.dumps(json.dumps([{"alertId": n["alertId"], "cuerpo": n["cuerpo"]} for n in lote]))
        js = ("const rows = EJSON.parse(%s);"
              "const ops = rows.map(r => ({updateOne:{filter:{alertId:r.alertId}, update:{$setOnInsert:r.cuerpo}, upsert:true}}));"
              "const r = db.alerts.bulkWrite(ops, {ordered:false});"
              "print(JSON.stringify({insertadas:r.upsertedCount, ya_existian:r.matchedCount}))") % cuerpo
        r = json.loads(ultima_salida(mongo(WH, js)))
        total["insertadas"] += r["insertadas"]
        total["ya_existian"] += r["ya_existian"]
        print(f"  lote {i // LOTE + 1}: {r}", flush=True)
    print("copiado:", total)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Copia el ESTADO VIGENTE de mep3 a -wh antes de que -wh asuma todo el polling
(corte "forma A", 13-oct-2026): solo las alertas ABIERTAS (resolvedAt:null) de
mep3 que -wh todavía no tiene. Sin historial, sin cerradas.

Por qué: -wh, al empezar a hacer polling, trataría como NUEVAS las alertas que
mep3 ya mandó a Helix y reenviaría sus alarmas (Helix identifica por nombre de
equipo). Con la copia, esas alertas llegan a -wh con su estado de envío
(isTcp:true) y -wh solo manda su cese cuando se resuelvan. Las abiertas SIN
GLPI también se copian (isGlpi:false, nunca se envían) para que -wh no las
redescubra y las valide una por una en GLPI.

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
import json
import re
import subprocess
import sys
from collections import Counter

M3 = ("mongodb-helix-mep", "ms_helix_mep", "ms-helix-mep")
WH = ("mongodb-helix-mep-wh", "ms_helix_mep-wh", "ms-helix-mep-wh")
INSERTADOS = "/tmp/migracion_estado_insertados.json"
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
    print("leyendo las abiertas de mep3...", flush=True)
    txt = ultima_salida(mongo(M3, "print(EJSON.stringify(db.alerts.find({resolvedAt:null}).toArray(), {relaxed:true}))"))
    docs = json.loads(txt)
    ids = [d["alertId"] for d in docs]
    ya = set(json.loads(ultima_salida(mongo(WH, f"const ids={json.dumps(ids)}; print(JSON.stringify(db.alerts.find({{alertId:{{$in:ids}}}},{{_id:0,alertId:1}}).toArray().map(a=>a.alertId)))"))))
    nuevos = preparar(docs, ya)
    pend = pendientes_de_envio(docs)
    print(f"abiertas en mep3: {len(docs)} | ya están en -wh (no se tocan): {len(ya)} | a copiar: {len(nuevos)}")
    nd = {d["alertId"]: d for d in docs}
    print("  a copiar por GLPI/envío:", dict(Counter(("glpi" if nd[n['alertId']].get("isGlpi") else "sin_glpi") + ("/enviada" if nd[n['alertId']].get("isTcp") else "/no_enviada") for n in nuevos)))
    print("  a copiar por tipo:", dict(Counter(nd[n['alertId']].get("type") for n in nuevos)))
    print(f"mep3: abiertas de GLPI con envío pendiente (isTcp:false): {len(pend)}", "-> DEBE SER 0 para aplicar" if pend else "")
    if not APLICAR:
        return print("\nPRUEBA: no se escribió nada. Repite con --aplicar (con la app de mep3 parada).")
    if app_corriendo(M3):
        sys.exit("ABORTADO: la app de mep3 sigue corriendo; páralas antes de copiar (docker compose stop ms-helix en su carpeta).")
    if pend:
        sys.exit("ABORTADO: mep3 tiene alertas de GLPI sin enviar; espera a que termine su ciclo de envío y repite.")
    if not nuevos:
        return print("nada que copiar.")
    json.dump([n["alertId"] for n in nuevos], open(INSERTADOS, "w"))
    cuerpo = json.dumps(json.dumps([{"alertId": n["alertId"], "cuerpo": n["cuerpo"]} for n in nuevos]))
    js = ("const rows = EJSON.parse(%s);"
          "const ops = rows.map(r => ({updateOne:{filter:{alertId:r.alertId}, update:{$setOnInsert:r.cuerpo}, upsert:true}}));"
          "const r = db.alerts.bulkWrite(ops, {ordered:false});"
          "print(JSON.stringify({insertadas:r.upsertedCount, ya_existian:r.matchedCount}))") % cuerpo
    print("copiado:", ultima_salida(mongo(WH, js)))


if __name__ == "__main__":
    main()

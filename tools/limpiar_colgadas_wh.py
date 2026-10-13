#!/usr/bin/env python3
"""
Limpieza de alertas `unreachable` que quedaron abiertas en -wh (y retenidas en
Helix) porque el cese nunca salió. Corre en el servidor. Cada paso es de
PRUEBA por defecto (no escribe nada); solo escribe con --aplicar.

Contexto (13-oct-2026): mep3 cerró esas alertas pero las tenía silenciadas
(TCP_SILENT_TYPES=unreachable, alarma y cese), y -wh no se enteró del cese
(429 en su barrido). Helix identifica la alarma por NOMBRE DE EQUIPO y un solo
cese cierra TODAS las alarmas del equipo, por eso el orden importa:

  paso1  mep3: re-marcar como PENDIENTES los ceses silenciados, para que
         mep3 los envíe a Helix (requiere TCP_SILENT_KEEP_CESE=true en mep3).
  paso2  -wh: cerrar localmente las colgadas con el resolvedAt de mep3 (para
         que Epistech reciba el cese y -wh deje de verlas abiertas). No envía
         a Helix (requiere TCP_SILENT_CESE_BEFORE en el futuro en -wh).
  paso3  reenviar la ALARMA de las alertas vigentes de los equipos afectados
         (el cese de paso1 las cerró en Helix). Se niega a correr mientras
         queden ceses del paso1 sin enviar.

Entradas (las crea el script de dimensionamiento):
  /tmp/cese_cerrables.json     colgadas: alertId, type, resolvedAt (de mep3)
  /tmp/alarmas_a_reenviar.json vigentes de equipos afectados

Uso:
  python3 limpiar_colgadas_wh.py paso1 [--aplicar]
  python3 limpiar_colgadas_wh.py paso2 [--aplicar]
  python3 limpiar_colgadas_wh.py paso3 [--aplicar]
Respaldo del estado previo en /tmp/limpieza_<paso>_respaldo.json.
"""
import json
import subprocess
import sys

M3 = ("mongodb-helix-mep", "ms_helix_mep", "ms-helix-mep")
WH = ("mongodb-helix-mep-wh", "ms_helix_mep-wh", "ms-helix-mep-wh")
CERRABLES = "/tmp/cese_cerrables.json"
VIGENTES = "/tmp/alarmas_a_reenviar.json"
APLICAR = "--aplicar" in sys.argv


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def mongo(inst, js):
    cont, db, _ = inst
    return sh(f"docker exec {cont} mongosh 'mongodb://andrair:1234@localhost:27017/{db}?authSource=admin' --quiet --eval '{js}'")


def env(inst, name):
    return sh(f"docker exec {inst[2]} printenv {name}").strip()


def decidir_dueno(tipo, created_ms, silent_from_ms, esta_en_wh_abierta):
    """Quién reenvía la alarma de una alerta vigente.

    mep3 solo silencia `unreachable` creadas desde TCP_SILENT_FROM; todo lo
    demás lo envía mep3. Una unreachable silenciada en mep3 solo la puede
    reenviar -wh (si la tiene abierta); si no, queda sin dueño.
    """
    if tipo != "unreachable":
        return "mep3"
    if created_ms < silent_from_ms:
        return "mep3"
    return "wh" if esta_en_wh_abierta else None


def abortar(msg):
    sys.exit(f"ABORTADO: {msg}")


def paso1():
    if env(M3, "TCP_SILENT_KEEP_CESE") != "true":
        abortar("mep3 no tiene TCP_SILENT_KEEP_CESE=true (hace falta para que el cese salga)")
    desde = env(M3, "TCP_SILENT_FROM")
    if not desde:
        abortar("mep3 no tiene TCP_SILENT_FROM")
    ids = [r["alertId"] for r in json.load(open(CERRABLES)) if r["type"] == "unreachable"]
    filtro = ('{alertId:{$in:ids},type:"unreachable",resolvedAt:{$ne:null},isTcp:true,'
              'createdAt:{$gte:new Date("%s")}}' % desde)
    pre = f"const ids={json.dumps(ids)};"
    n = mongo(M3, pre + f"print(db.alerts.countDocuments({filtro}))").strip()
    print(f"paso1: {len(ids)} unreachable colgadas en la lista | silenciadas en mep3 que se re-marcarían: {n}")
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    resp = mongo(M3, pre + f'print(JSON.stringify(db.alerts.find({filtro},{{_id:0,alertId:1,isTcp:1}}).toArray()))')
    open("/tmp/limpieza_paso1_respaldo.json", "w").write(resp)
    mod = mongo(M3, pre + f"print(db.alerts.updateMany({filtro},{{$set:{{isTcp:false}}}}).modifiedCount)").strip()
    print(f"paso1: re-marcadas como pendientes en mep3: {mod}. Se enviarán en el próximo ciclo (1 min).")


def paso2():
    antes = env(WH, "TCP_SILENT_CESE_BEFORE")
    if not antes or int(antes[:4] or 0) < 2090:
        abortar("-wh no tiene TCP_SILENT_CESE_BEFORE en el futuro: sus ceses saldrían a Helix")
    filas = [[r["alertId"], r["resolvedAt"]] for r in json.load(open(CERRABLES))]
    ids = [f[0] for f in filas]
    pre = f"const ids={json.dumps(ids)};"
    n = mongo(WH, pre + "print(db.alerts.countDocuments({alertId:{$in:ids},resolvedAt:null}))").strip()
    print(f"paso2: {len(filas)} en la lista | abiertas hoy en -wh que se cerrarían: {n}")
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    resp = mongo(WH, pre + 'print(JSON.stringify(db.alerts.find({alertId:{$in:ids},resolvedAt:null},{_id:0,alertId:1,resolvedAt:1,isTcp:1}).toArray()))')
    open("/tmp/limpieza_paso2_respaldo.json", "w").write(resp)
    js = ("const rows=%s; let n=0; rows.forEach(r=>{n+=db.alerts.updateOne({alertId:r[0],resolvedAt:null},"
          "{$set:{resolvedAt:r[1],isTcp:false}}).modifiedCount}); print(n)") % json.dumps(filas)
    print(f"paso2: cerradas en -wh: {mongo(WH, js).strip()}")


def paso3():
    ids_p1 = [r["alertId"] for r in json.load(open(CERRABLES)) if r["type"] == "unreachable"]
    pendientes = mongo(M3, f'const ids={json.dumps(ids_p1)}; print(db.alerts.countDocuments({{alertId:{{$in:ids}},type:"unreachable",resolvedAt:{{$ne:null}},isTcp:false}}))').strip()
    if pendientes != "0":
        abortar(f"quedan {pendientes} ceses del paso1 sin enviar en mep3: espera a que salgan antes de reenviar alarmas")
    desde_ms = int(__import__("datetime").datetime.fromisoformat(env(M3, "TCP_SILENT_FROM").replace("Z", "+00:00")).timestamp() * 1000)
    vig = json.load(open(VIGENTES))
    ids = [v["alertId"] for v in vig]
    pre = f"const ids={json.dumps(ids)};"
    m3 = {l.split("|")[0]: l.split("|")[1:] for l in mongo(M3, pre + 'db.alerts.find({alertId:{$in:ids},resolvedAt:null},{_id:0,alertId:1,type:1,createdAt:1}).forEach(a=>print(a.alertId+"|"+a.type+"|"+a.createdAt.getTime()))').splitlines() if "|" in l}
    en_wh = set(mongo(WH, pre + 'db.alerts.find({alertId:{$in:ids},resolvedAt:null},{_id:0,alertId:1}).forEach(a=>print(a.alertId))').split())
    plan = {"mep3": [], "wh": [], "sin_dueno": []}
    for v in vig:
        if v["alertId"] not in m3:
            plan["sin_dueno"].append(v["alertId"]); continue
        tipo, creada = m3[v["alertId"]][0], int(m3[v["alertId"]][1])
        dueno = decidir_dueno(tipo, creada, desde_ms, v["alertId"] in en_wh)
        plan[dueno or "sin_dueno"].append(v["alertId"])
        print(f"  {v['alertId']} {tipo:30} {v['device']:24} -> {dueno or 'SIN DUEÑO'}")
    print(f"paso3: reenviar por mep3: {len(plan['mep3'])} | por -wh: {len(plan['wh'])} | sin dueño (revisar a mano): {len(plan['sin_dueno'])}")
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    open("/tmp/limpieza_paso3_respaldo.json", "w").write(json.dumps(plan))
    for clave, inst in (("mep3", M3), ("wh", WH)):
        if plan[clave]:
            js = f'const ids={json.dumps(plan[clave])}; print(db.alerts.updateMany({{alertId:{{$in:ids}},resolvedAt:null}},{{$set:{{isTcp:false}}}}).modifiedCount)'
            print(f"paso3: re-marcadas en {clave}: {mongo(inst, js).strip()}")


if __name__ == "__main__":
    pasos = {"paso1": paso1, "paso2": paso2, "paso3": paso3}
    if len(sys.argv) < 2 or sys.argv[1] not in pasos:
        sys.exit(__doc__)
    pasos[sys.argv[1]]()

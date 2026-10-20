#!/usr/bin/env python3
"""
Reposición de ALARMAS RETENIDAS en Helix tras el fallo de silencio de -wh
(20-oct-2026). Corre en el servidor. Todo es PRUEBA por defecto: solo escribe
con --aplicar.

Qué pasó: -wh llevaba dentro de la imagen un .env viejo con TCP_SILENT_* y
`dotenv` las cargaba aunque el .env del servidor ya no las tuviera. Resultado:
  - los CESES de alertas `unreachable` se omitían del TCP pero se marcaban como
    enviados -> alarmas retenidas en Helix (ceses de alertas ya cerradas);
  - las ALARMAS de dns_down, crc_errors, ip_conflict, ethernet_negotiation_failure,
    fan_down, udld_err_unidir, mps_down, poe_denied y firewall nunca salieron.

Qué hace (reutiliza el ciclo de envío normal de -wh: solo vuelve a marcar
isTcp:false y -wh envía en el siguiente minuto; no escribe en el TCP ni en Helix):

  plan     calcula y guarda el plan (/tmp/reposicion_plan.json), sin escribir en las bases:
             ceses   = alertas CERRADAS en -wh cuya alarma sigue ACTIVA en el TCP
             alarmas = alertas ABIERTAS en -wh que (a) el TCP no tiene activas, o
                       (b) son de un equipo que va a recibir un cese (Helix cierra
                       TODAS las alarmas de un equipo con un cese, hay que reponerlas)
  ceses    reenvía los ceses del plan en lotes (--lote N, por defecto 300)
  estado   mide el avance (TCP vs -wh), solo lectura
  alarmas  reenvía las alarmas del plan; SE NIEGA a correr mientras queden ceses
           por enviar o sin confirmar en el TCP (orden: ceses primero)

Guardas: se niega a escribir si el proceso de -wh ve alguna TCP_SILENT_* con valor
o TCP_ENABLED=false (justo la causa del fallo); el plan debe tener menos de 6 h;
cada fase deja respaldo en /tmp/reposicion_respaldo_<fase>_<n>.json y la lista de
ya aplicadas en /tmp/reposicion_*_aplicados.json (no repite).

Uso:
  python3 reponer_ceses_y_alarmas.py plan
  python3 reponer_ceses_y_alarmas.py ceses [--lote 300] [--aplicar]
  python3 reponer_ceses_y_alarmas.py estado
  python3 reponer_ceses_y_alarmas.py alarmas [--aplicar]
`plan` también avisa de COLISIONES: alarmas de otros puentes (AyA, ACS2...) con el mismo
nombre de equipo que uno de los ceses; `ceses` se niega a correr si las hay (--ignorar-colisiones).
No cubre las alarmas HUÉRFANAS (sin alerta en -wh ni en mep3): se listan en `plan`
para verificarlas contra Meraki antes de tocarlas.
"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

from migrar_estado_a_wh import WH, mongo, ultima_salida
from auditar_retenidas_tcp import consulta_tcp, consulta_app, por_ids, equipo

PLAN = "/tmp/reposicion_plan.json"
CESES_APLICADOS = "/tmp/reposicion_ceses_aplicados.json"
ALARMAS_APLICADAS = "/tmp/reposicion_alarmas_aplicadas.json"
APLICAR = "--aplicar" in sys.argv
LOTE = int(sys.argv[sys.argv.index("--lote") + 1]) if "--lote" in sys.argv else 300
EDAD_MAX_PLAN_S = 6 * 3600


def abortar(msg):
    sys.exit(f"ABORTADO: {msg}")


def armar_plan(tcp_activos, wh_por_id, abiertas_wh):
    """Función pura. Devuelve {'ceses': [...], 'alarmas': [...]} (ver docstring)."""
    activos_ids = {t["alertId"] for t in tcp_activos if not t["alertId"].startswith("MW-")}
    ceses = []
    for aid in activos_ids:
        w = wh_por_id.get(aid)
        if w is not None and w.get("resolvedAt") and w.get("isGlpi") is True:
            ceses.append({"alertId": aid, "resolvedAt": w["resolvedAt"], "eq": equipo(w), "type": w.get("type")})
    equipos_con_cese = {c["eq"] for c in ceses if c["eq"]}
    alarmas = {}
    for a in abiertas_wh:
        aid = a["alertId"]
        if aid not in activos_ids:
            alarmas[aid] = {"alertId": aid, "eq": equipo(a), "type": a.get("type"), "motivo": "sin_alarma_en_tcp"}
        elif equipo(a) in equipos_con_cese:
            alarmas[aid] = {"alertId": aid, "eq": equipo(a), "type": a.get("type"), "motivo": "equipo_con_cese"}
    return {"ceses": sorted(ceses, key=lambda c: str(c["resolvedAt"])), "alarmas": list(alarmas.values())}


def colisiones(tcp_activos, wh_por_id, equipos_con_cese):
    """Función pura. Alarmas activas en el TCP que NO son de -wh (otros puentes u organizaciones)
    pero cuyo NOMBRE DE EQUIPO coincide con uno que va a recibir un cese: Helix identifica por
    nombre, así que ese cese cerraría también esas alarmas ajenas."""
    return [
        {"alertId": t["alertId"], "eq": t.get("nombreEquipo"), "cliente": t.get("nombreCliente")}
        for t in tcp_activos
        if not t["alertId"].startswith("MW-") and t["alertId"] not in wh_por_id and t.get("nombreEquipo") in equipos_con_cese
    ]


def entorno_ok():
    """El proceso de -wh (con dotenv, como lo ve la aplicación) no debe tener silencios ni TCP apagado."""
    js = ('require("dotenv/config");console.log(JSON.stringify(Object.fromEntries('
          'Object.entries(process.env).filter(([k])=>k.includes("SILENT")||k==="TCP_ENABLED"))))')
    p = subprocess.run(["docker", "exec", "ms-helix-mep-wh", "node", "-e", js], capture_output=True, text=True)
    try:
        d = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        abortar(f"no pude leer el entorno de -wh: {p.stdout[-200:]} {p.stderr[-200:]}")
    silencios = {k: v for k, v in d.items() if "SILENT" in k and v}
    if silencios:
        abortar(f"-wh tiene reglas de silencio activas ({silencios}); corrige eso primero o la reposición se perdería")
    if d.get("TCP_ENABLED") == "false":
        abortar("-wh tiene TCP_ENABLED=false: no enviaría nada a Helix")


def leer_json(ruta, defecto):
    try:
        return json.load(open(ruta))
    except Exception:
        return defecto


def cargar_plan():
    if not os.path.exists(PLAN):
        abortar(f"no hay plan: corre primero `plan` ({PLAN})")
    if time.time() - os.path.getmtime(PLAN) > EDAD_MAX_PLAN_S:
        abortar("el plan tiene más de 6 h; vuelve a correr `plan` para que refleje el estado actual")
    return json.load(open(PLAN))


def marcar_pendientes(ids, cerradas):
    """isTcp:false SOLO si sigue como lo calculó el plan (cerrada o abierta) y marcada como enviada."""
    filtro = "{alertId:{$in:ids},resolvedAt:%s,isTcp:true}" % ("{$ne:null}" if cerradas else "null")
    js = ("const ids=%s;const r=db.alerts.updateMany(%s,{$set:{isTcp:false}});"
          "print(JSON.stringify({coincidieron:r.matchedCount,marcadas:r.modifiedCount}))") % (json.dumps(ids), filtro)
    return json.loads(ultima_salida(mongo(WH, js)))


def tcp_inactivos(ids):
    docs = consulta_tcp("{alertId:{$in:%s}}" % json.dumps(ids)) if ids else []
    return sum(1 for d in docs if d.get("isActive") is False), len(docs)


def pendientes_cese_wh():
    return int(ultima_salida(mongo(WH, 'print(db.alerts.countDocuments({isGlpi:true,isTcp:false,resolvedAt:{$ne:null}}))')))


def cmd_plan():
    activos = [t for t in consulta_tcp("{isActive:true}") if not t["alertId"].startswith("MW-")]
    wh = por_ids(WH, [t["alertId"] for t in activos])
    abiertas = consulta_app(WH, "{resolvedAt:null,isGlpi:true}")
    plan = armar_plan(activos, wh, abiertas)
    plan["colisiones"] = colisiones(activos, wh, {c["eq"] for c in plan["ceses"] if c["eq"]})
    json.dump(plan, open(PLAN, "w"))
    huerfanas = [t for t in activos if t["alertId"] not in wh]
    print(f"alarmas activas en el TCP (sin guardián): {len(activos)}")
    print(f"  CESES a reenviar (cerradas en -wh, alarma activa en el TCP): {len(plan['ceses'])}")
    print("    por tipo:", dict(Counter(c['type'] for c in plan['ceses'])))
    print(f"    equipos distintos: {len({c['eq'] for c in plan['ceses']})}")
    print(f"  ALARMAS a reenviar (después de los ceses): {len(plan['alarmas'])}")
    print("    por motivo:", dict(Counter(a['motivo'] for a in plan['alarmas'])))
    print("    por tipo:", dict(Counter(a['type'] for a in plan['alarmas'])))
    print(f"  COLISIONES (alarmas de OTROS puentes con el mismo nombre de equipo que un cese del plan): {len(plan['colisiones'])}")
    for c in plan["colisiones"][:15]:
        print(f"    {c['eq']} | {c['cliente']} | {c['alertId']}")
    print(f"  HUÉRFANAS (sin alerta en -wh: alarmas de otros puentes/organizaciones o muy antiguas; NO se tocan): {len(huerfanas)}")
    print("    por cliente:", dict(Counter(t.get('nombreCliente') for t in huerfanas)))
    for t in huerfanas[:15]:
        print(f"    {t.get('nombreEquipo')} | {t.get('evento','')[:35]} | {t.get('nombreCliente')} | {str(t.get('createdAt'))[:30]}")
    print(f"\nplan guardado en {PLAN}")


def cmd_ceses():
    plan = cargar_plan()
    entorno_ok()
    if plan.get("colisiones") and "--ignorar-colisiones" not in sys.argv:
        abortar(f"el plan tiene {len(plan['colisiones'])} colisiones (alarmas ajenas con el mismo nombre de equipo): "
                "revísalas con `plan`; usa --ignorar-colisiones solo si sabes que son las mismas")
    hechos = set(leer_json(CESES_APLICADOS, []))
    pendientes = [c for c in plan["ceses"] if c["alertId"] not in hechos]
    lote = pendientes[:LOTE]
    print(f"ceses del plan: {len(plan['ceses'])} | ya aplicados: {len(hechos)} | pendientes: {len(pendientes)} | este lote: {len(lote)}")
    if not lote:
        return print("nada que aplicar.")
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    ids = [c["alertId"] for c in lote]
    n = len(hechos) // max(LOTE, 1) + 1
    json.dump(ids, open(f"/tmp/reposicion_respaldo_ceses_{n}.json", "w"))
    r = marcar_pendientes(ids, cerradas=True)
    print("marcadas como pendientes (-wh las enviará en el próximo ciclo, cada minuto):", r)
    json.dump(sorted(hechos | set(ids)), open(CESES_APLICADOS, "w"))
    print(f"quedan {len(pendientes) - len(lote)} por aplicar. Espera 3-5 min y mira `estado` antes del siguiente lote.")


def cmd_estado():
    plan = cargar_plan()
    hechos = leer_json(CESES_APLICADOS, [])
    inact, existen = tcp_inactivos(hechos)
    print(f"ceses del plan: {len(plan['ceses'])} | aplicados: {len(hechos)}")
    print(f"  de los aplicados, ya con alarma INACTIVA en el TCP (cese entregado): {inact} de {existen}")
    print(f"  cerradas de -wh todavía pendientes de envío (isTcp:false): {pendientes_cese_wh()}")
    ah = leer_json(ALARMAS_APLICADAS, [])
    print(f"alarmas del plan: {len(plan['alarmas'])} | aplicadas: {len(ah)}")


def cmd_alarmas():
    plan = cargar_plan()
    entorno_ok()
    hechos = set(leer_json(CESES_APLICADOS, []))
    faltan = [c for c in plan["ceses"] if c["alertId"] not in hechos]
    if faltan:
        abortar(f"faltan {len(faltan)} ceses por aplicar; los ceses van primero")
    inact, existen = tcp_inactivos(sorted(hechos))
    if existen and inact < 0.99 * existen:
        abortar(f"solo {inact} de {existen} ceses figuran entregados en el TCP; espera y mira `estado`")
    pend = pendientes_cese_wh()
    if pend:
        abortar(f"{pend} ceses de -wh siguen pendientes de envío; espera a que salgan")
    ya = set(leer_json(ALARMAS_APLICADAS, []))
    ids = [a["alertId"] for a in plan["alarmas"] if a["alertId"] not in ya]
    print(f"alarmas del plan: {len(plan['alarmas'])} | ya aplicadas: {len(ya)} | a aplicar: {len(ids)}")
    if not ids:
        return print("nada que aplicar.")
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    json.dump(ids, open("/tmp/reposicion_respaldo_alarmas.json", "w"))
    r = marcar_pendientes(ids, cerradas=False)
    print("marcadas como pendientes (se enviarán como ALARMA en el próximo ciclo):", r)
    json.dump(sorted(ya | set(ids)), open(ALARMAS_APLICADAS, "w"))


if __name__ == "__main__":
    comando = next((a for a in sys.argv[1:] if a in ("plan", "ceses", "estado", "alarmas")), None)
    {"plan": cmd_plan, "ceses": cmd_ceses, "estado": cmd_estado, "alarmas": cmd_alarmas}.get(comando, lambda: abortar("uso: plan | ceses | estado | alarmas"))()

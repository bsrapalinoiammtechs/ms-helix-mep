#!/usr/bin/env python3
"""
Cierre PUNTUAL de alertas abiertas en -wh según lo que diga Meraki ahora.
Corre en el servidor. PRUEBA por defecto; solo escribe con --aplicar.

Para cada alerta ABIERTA en -wh (de los equipos de --equipos archivo.txt, o de
los alertId indicados) consulta a Meraki (endpoint de -wh /admin/meraki/alerts/lookup,
que pasa por el gateway con límite de tasa: ~20 s por alerta) y decide:
  CESADA         -> cerrar con el resolvedAt de Meraki (o dismissedAt, o ahora)
  NO_ENCONTRADA  -> cerrar con la hora actual (igual que reconciliation:force_not_found)
  ACTIVA         -> NO tocar (el equipo sigue caído, la alarma en Helix es legítima)
  ERROR          -> NO tocar
Cerrar = $set {resolvedAt, isTcp:false, resolvedVia, reconciledAt}; el ciclo normal de
-wh envía el CESE en el siguiente minuto (a Helix y a Epistech).

Por qué existe: el polling de ceses no ve las alertas con startedAt antiguo y la
conciliación horaria revisa 60 por corrida (~7 h para recorrer todas), así que una
alerta cesada en Meraki puede tardar horas en cerrarse sola.

Guardas: se niega si -wh tiene reglas de silencio/TCP apagado; máximo 60 alertas por
corrida (--max N); respaldo en /tmp/cierre_meraki_respaldo_<hora>.json.
Avisa de los EQUIPOS que quedarán con otra alerta abierta: Helix cierra TODAS las
alarmas de un equipo con un cese, esas alarmas hay que reponerlas después.

Uso:
  python3 cerrar_segun_meraki.py --equipos /tmp/equipos_cliente2.txt
  python3 cerrar_segun_meraki.py --equipos /tmp/equipos_cliente2.txt --aplicar
  python3 cerrar_segun_meraki.py 3865777330155415833 3865777330155415832 [--aplicar]
"""
import base64
import datetime
import json
import subprocess
import sys
import urllib.request

from migrar_estado_a_wh import WH, mongo, ultima_salida
from auditar_retenidas_tcp import consulta_app, equipo
from reponer_ceses_y_alarmas import entorno_ok, abortar

APLICAR = "--aplicar" in sys.argv
MAX = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 60
URL = "http://localhost:3015/admin/meraki/alerts/lookup"


def decidir(alerta_wh, meraki, ahora_iso):
    """Función pura. Devuelve (accion, resolvedAt|None, motivo)."""
    if alerta_wh.get("resolvedAt"):
        return ("ignorar", None, "ya cerrada en -wh")
    est = (meraki or {}).get("estado")
    if est == "CESADA":
        return ("cerrar", meraki.get("resolvedAt") or meraki.get("dismissedAt") or ahora_iso, "cesada en Meraki")
    if est == "NO_ENCONTRADA":
        return ("cerrar", ahora_iso, "no existe en Meraki")
    if est == "ACTIVA":
        return ("mantener", None, "sigue ACTIVA en Meraki")
    return ("mantener", None, f"sin dato fiable ({est}: {(meraki or {}).get('error')})")


def equipos_con_otras_abiertas(a_cerrar, abiertas_por_equipo, ids_a_cerrar):
    """Función pura: equipos que se cierran pero conservan otra alerta abierta (hay que reponer su alarma)."""
    res = {}
    for eq in {equipo(a) for a in a_cerrar if equipo(a)}:
        otras = [x["alertId"] for x in abiertas_por_equipo.get(eq, []) if x["alertId"] not in ids_a_cerrar]
        if otras:
            res[eq] = otras
    return res


def credenciales():
    def var(n):
        return subprocess.run(["docker", "exec", "ms-helix-mep-wh", "printenv", n], capture_output=True, text=True).stdout.strip()
    u, p = var("BULLBOARD_USER"), var("BULLBOARD_PASSWORD")
    if not u or not p:
        abortar("BULLBOARD_USER/BULLBOARD_PASSWORD no definidos en -wh: no puedo consultar a Meraki")
    return u, p


def consultar_meraki(ids):
    u, p = credenciales()
    req = urllib.request.Request(
        URL, data=json.dumps({"alertIds": ids}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Basic " + base64.b64encode(f"{u}:{p}".encode()).decode()})
    with urllib.request.urlopen(req, timeout=1500) as r:
        return {x["alertId"]: x for x in json.load(r)["results"]}


def main():
    entorno_ok()
    pos = [a for a in sys.argv[1:] if a.isdigit()]
    if "--equipos" in sys.argv:
        nombres = [l.strip().split(";")[0] for l in open(sys.argv[sys.argv.index("--equipos") + 1], encoding="utf-8") if l.strip()]
        abiertas = consulta_app(WH, "{resolvedAt:null,'scope.devices.name':{$in:%s}}" % json.dumps(nombres))
    elif pos:
        abiertas = consulta_app(WH, "{resolvedAt:null,alertId:{$in:%s}}" % json.dumps(pos))
    else:
        abortar("indica --equipos archivo.txt o uno o más alertId")
    if not abiertas:
        return print("no hay alertas abiertas en -wh para eso.")
    if len(abiertas) > MAX:
        abortar(f"{len(abiertas)} alertas abiertas (> --max {MAX}); acota la lista o sube --max")
    print(f"alertas abiertas en -wh a consultar en Meraki: {len(abiertas)} (~{len(abiertas) * 20 // 60 + 1} min)", flush=True)
    meraki = consultar_meraki([a["alertId"] for a in abiertas])
    ahora = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    acciones = []
    for a in abiertas:
        accion, res, motivo = decidir(a, meraki.get(a["alertId"]), ahora)
        print(f"  [{accion}] {equipo(a)} {a.get('type')} alerta={a['alertId']} ini={str(a.get('startedAt'))[:19]} | {motivo}" + (f" -> resolvedAt={res}" if res else ""))
        if accion == "cerrar":
            acciones.append({"alertId": a["alertId"], "resolvedAt": res, "motivo": motivo})
    ids_cerrar = {x["alertId"] for x in acciones}
    por_equipo = {}
    for a in abiertas:
        por_equipo.setdefault(equipo(a), []).append(a)
    avisos = equipos_con_otras_abiertas([a for a in abiertas if a["alertId"] in ids_cerrar], por_equipo, ids_cerrar)
    for eq, otras in avisos.items():
        print(f"  AVISO: {eq} se cierra pero conserva otra(s) abierta(s) {otras}: Helix cerraría también esas alarmas; repónlas después (isTcp:false).")
    print(f"\na cerrar: {len(acciones)} | a mantener/ignorar: {len(abiertas) - len(acciones)}")
    if not acciones:
        return
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    json.dump(acciones, open("/tmp/cierre_meraki_respaldo_%s.json" % datetime.datetime.now().strftime("%H%M%S"), "w"))
    js = ("const xs=%s;let n=0;for(const x of xs){const r=db.alerts.updateOne({alertId:x.alertId,resolvedAt:null},"
          "{$set:{resolvedAt:x.resolvedAt,isTcp:false,resolvedVia:'manual:meraki_lookup',reconciledAt:new Date()}});n+=r.modifiedCount}"
          "print(JSON.stringify({cerradas:n}))") % json.dumps(acciones)
    print("cierre aplicado (-wh enviará el cese en el próximo ciclo):", ultima_salida(mongo(WH, js)))


if __name__ == "__main__":
    main()

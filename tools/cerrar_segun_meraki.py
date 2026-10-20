#!/usr/bin/env python3
"""
Cierre PUNTUAL de alertas abiertas según lo que diga Meraki ahora (-wh u otra organización).
Corre en el servidor. PRUEBA por defecto; solo escribe con --aplicar.

Para cada alerta ABIERTA (de los equipos de --equipos archivo.txt, de los alertId indicados
o de TODAS las abiertas de GLPI con --todas) consulta a Meraki y decide:
  CESADA         -> cerrar con el resolvedAt de Meraki (o dismissedAt, o ahora)
  NO_ENCONTRADA  -> cerrar con la hora actual (igual que reconciliation:force_not_found)
  ACTIVA         -> NO tocar (el equipo sigue caído, la alarma en Helix es legítima)
  ERROR          -> NO tocar
Cerrar = $set {resolvedAt, isTcp, resolvedVia, reconciledAt}.
  - isTcp:false -> el ciclo normal del servicio envía el CESE en el siguiente minuto.
  - isTcp:true  -> cierre SILENCIOSO: no se envía nada (solo con --silencioso, y solo si el TCP
                   NO tiene una alarma activa de esa alerta: nunca hubo nada que cerrar en Helix).
                   Evita que un cese de una alerta fantasma cierre por nombre de equipo alarmas ajenas.

Modos de consulta a Meraki:
  (por defecto)  endpoint /admin/meraki/alerts/lookup de -wh (pasa por su gateway; ~20 s por alerta)
  --directo      con TOKEN_CISCO y ORGANIZATION_ID del contenedor de la instancia, una petición cada
                 --espera segundos (30 por defecto). Para organizaciones sin ese endpoint (ACS2...).
                 La espera deja margen al propio polling de la instancia (límite: 1 petición/10 s).
Otras instancias: --instancia contenedor_mongo,base,contenedor_app   (por defecto, -wh)
Resultados de Meraki: --cache archivo.json los guarda; --usar-cache los reutiliza (no repite
las consultas al aplicar; vale 4 h).

Guardas: en -wh se niega si hay reglas de silencio/TCP apagado; máximo 60 alertas por corrida
(--max N); respaldo en /tmp/cierre_meraki_respaldo_<hora>.json. Avisa de los EQUIPOS que
quedarán con otra alerta abierta: Helix cierra TODAS las alarmas de un equipo con un cese.

Uso:
  python3 cerrar_segun_meraki.py --equipos /tmp/equipos_cliente2.txt [--aplicar]
  python3 cerrar_segun_meraki.py 3865777330155415833 [--aplicar]
  # ACS2, todas las abiertas, consulta directa, en segundo plano (194 x 30 s ~ 100 min):
  nohup python3 cerrar_segun_meraki.py --instancia mongodb-helix-acs2,ms_helix_acs2,ms-helix-acs2 \\
      --todas --directo --silencioso --max 400 --cache /tmp/lookup_acs2_todas.json > /tmp/cierre_acs2.out 2>&1 &
  python3 cerrar_segun_meraki.py --instancia ... --todas --directo --silencioso --max 400 \\
      --usar-cache --cache /tmp/lookup_acs2_todas.json --aplicar
"""
import base64
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from migrar_estado_a_wh import WH, mongo, ultima_salida
from auditar_retenidas_tcp import consulta_app, consulta_tcp, equipo
from reponer_ceses_y_alarmas import entorno_ok, abortar


def argval(flag, defecto=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else defecto


APLICAR = "--aplicar" in sys.argv
MAX = int(argval("--max", "60"))
INST = tuple(argval("--instancia").split(",")) if "--instancia" in sys.argv else WH
DIRECTO = "--directo" in sys.argv
ESPERA = int(argval("--espera", "30"))
SILENCIOSO = "--silencioso" in sys.argv
CACHE = argval("--cache")
USAR_CACHE = "--usar-cache" in sys.argv
URL = "http://localhost:3015/admin/meraki/alerts/lookup"


def decidir(alerta_wh, meraki, ahora_iso):
    """Función pura. Devuelve (accion, resolvedAt|None, motivo)."""
    if alerta_wh.get("resolvedAt"):
        return ("ignorar", None, "ya cerrada")
    est = (meraki or {}).get("estado")
    if est == "CESADA":
        return ("cerrar", meraki.get("resolvedAt") or meraki.get("dismissedAt") or ahora_iso, "cesada en Meraki")
    if est == "NO_ENCONTRADA":
        return ("cerrar", ahora_iso, "no existe en Meraki")
    if est == "ACTIVA":
        return ("mantener", None, "sigue ACTIVA en Meraki")
    return ("mantener", None, f"sin dato fiable ({est}: {(meraki or {}).get('error')})")


def valor_istcp(alert_id, tcp_activos_ids, silencioso):
    """Función pura. False = el servicio enviará el cese; True = cierre silencioso (sin alarma activa en el TCP)."""
    return bool(silencioso and alert_id not in tcp_activos_ids)


def equipos_con_otras_abiertas(a_cerrar, abiertas_por_equipo, ids_a_cerrar):
    """Función pura: equipos que se cierran pero conservan otra alerta abierta (hay que reponer su alarma)."""
    res = {}
    for eq in {equipo(a) for a in a_cerrar if equipo(a)}:
        otras = [x["alertId"] for x in abiertas_por_equipo.get(eq, []) if x["alertId"] not in ids_a_cerrar]
        if otras:
            res[eq] = otras
    return res


def var_contenedor(contenedor, nombre):
    return subprocess.run(["docker", "exec", contenedor, "printenv", nombre], capture_output=True, text=True).stdout.strip()


def consultar_endpoint(ids):
    u, p = var_contenedor("ms-helix-mep-wh", "BULLBOARD_USER"), var_contenedor("ms-helix-mep-wh", "BULLBOARD_PASSWORD")
    if not u or not p:
        abortar("BULLBOARD_USER/BULLBOARD_PASSWORD no definidos en -wh: usa --directo")
    req = urllib.request.Request(
        URL, data=json.dumps({"alertIds": ids}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Basic " + base64.b64encode(f"{u}:{p}".encode()).decode()})
    with urllib.request.urlopen(req, timeout=3000) as r:
        return {x["alertId"]: x for x in json.load(r)["results"]}


def consultar_directo(ids):
    tok, org = var_contenedor(INST[2], "TOKEN_CISCO"), var_contenedor(INST[2], "ORGANIZATION_ID")
    if not tok or not org:
        abortar(f"faltan TOKEN_CISCO/ORGANIZATION_ID en {INST[2]}")
    res = {}
    for k, i in enumerate(ids, 1):
        r = {"alertId": i, "estado": "ERROR"}
        for intento in (1, 2):
            try:
                d = json.load(urllib.request.urlopen(urllib.request.Request(
                    f"https://api.meraki.com/api/v1/organizations/{org}/assurance/alerts/{i}",
                    headers={"Authorization": "Bearer " + tok}), timeout=30))
                r = {"alertId": i, "estado": "CESADA" if d.get("resolvedAt") or d.get("dismissedAt") else "ACTIVA",
                     "resolvedAt": d.get("resolvedAt"), "dismissedAt": d.get("dismissedAt")}
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    r = {"alertId": i, "estado": "NO_ENCONTRADA"}
                    break
                r = {"alertId": i, "estado": "ERROR", "error": f"HTTP {e.code}"}
                if e.code == 429 and intento == 1:
                    time.sleep(60)
                    continue
                break
            except Exception as e:  # red, timeout...
                r = {"alertId": i, "estado": "ERROR", "error": str(e)[:80]}
                break
        res[i] = r
        print(f"  consultada {k}/{len(ids)}: {i} -> {r['estado']}", flush=True)
        time.sleep(ESPERA)
    return res


def main():
    if INST == WH:
        entorno_ok()
    elif not DIRECTO:
        abortar("con otra instancia usa --directo (solo -wh tiene el endpoint de consulta)")
    pos = [a for a in sys.argv[1:] if a.isdigit()]
    if "--todas" in sys.argv:
        abiertas = consulta_app(INST, "{resolvedAt:null,isGlpi:true}")
    elif "--equipos" in sys.argv:
        nombres = [l.strip().split(";")[0] for l in open(argval("--equipos"), encoding="utf-8") if l.strip()]
        abiertas = consulta_app(INST, "{resolvedAt:null,'scope.devices.name':{$in:%s}}" % json.dumps(nombres))
    elif pos:
        abiertas = consulta_app(INST, "{resolvedAt:null,alertId:{$in:%s}}" % json.dumps(pos))
    else:
        abortar("indica --todas, --equipos archivo.txt o uno o más alertId")
    if not abiertas:
        return print("no hay alertas abiertas para eso.")
    if len(abiertas) > MAX:
        abortar(f"{len(abiertas)} alertas abiertas (> --max {MAX}); acota la lista o sube --max")
    ids = [a["alertId"] for a in abiertas]

    if USAR_CACHE:
        if not CACHE or not os.path.exists(CACHE):
            abortar("--usar-cache necesita --cache archivo.json existente")
        if time.time() - os.path.getmtime(CACHE) > 4 * 3600:
            abortar("la caché tiene más de 4 h; vuelve a consultar a Meraki")
        meraki = json.load(open(CACHE))
        print(f"usando caché de Meraki ({len(meraki)} resultados)")
    else:
        print(f"alertas abiertas a consultar en Meraki: {len(abiertas)}"
              + (f" (~{len(abiertas) * ESPERA // 60 + 1} min)" if DIRECTO else f" (~{len(abiertas) * 20 // 60 + 1} min)"), flush=True)
        meraki = consultar_directo(ids) if DIRECTO else consultar_endpoint(ids)
        if CACHE:
            json.dump(meraki, open(CACHE, "w"))

    activos = {t["alertId"] for t in consulta_tcp("{isActive:true}")} if SILENCIOSO else set()
    ahora = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    acciones, conteo = [], {}
    for a in abiertas:
        accion, res, motivo = decidir(a, meraki.get(a["alertId"]), ahora)
        conteo[accion + ":" + motivo.split(" (")[0]] = conteo.get(accion + ":" + motivo.split(" (")[0], 0) + 1
        silencioso = valor_istcp(a["alertId"], activos, SILENCIOSO)
        if accion != "ignorar" and (accion == "cerrar" or len(abiertas) <= 40):
            print(f"  [{accion}{' SILENCIOSO' if accion == 'cerrar' and silencioso else ''}] {equipo(a)} {a.get('type')} alerta={a['alertId']} "
                  f"ini={str(a.get('startedAt'))[:19]} | {motivo}" + (f" -> resolvedAt={res}" if res else "")
                  if len(abiertas) <= 60 else "", end="" if len(abiertas) > 60 else "\n")
        if accion == "cerrar":
            acciones.append({"alertId": a["alertId"], "resolvedAt": res, "motivo": motivo, "isTcp": silencioso})
    print("\nresumen de la consulta:", conteo)
    ids_cerrar = {x["alertId"] for x in acciones}
    por_equipo = {}
    for a in abiertas:
        por_equipo.setdefault(equipo(a), []).append(a)
    avisos = equipos_con_otras_abiertas([a for a in abiertas if a["alertId"] in ids_cerrar], por_equipo, ids_cerrar)
    for eq, otras in list(avisos.items())[:40]:
        print(f"  AVISO: {eq} se cierra pero conserva otra(s) abierta(s) {otras}: si se envía cese, Helix cerraría también esas alarmas.")
    con_cese = [x for x in acciones if not x["isTcp"]]
    print(f"\na cerrar: {len(acciones)} (con cese: {len(con_cese)} | silenciosas: {len(acciones) - len(con_cese)}) | a mantener/ignorar: {len(abiertas) - len(acciones)}")
    for x in con_cese[:30]:
        print(f"    con cese: {x['alertId']} ({x['motivo']})")
    if not acciones:
        return
    if not APLICAR:
        return print("PRUEBA: no se escribió nada. Repite con --aplicar.")
    json.dump(acciones, open("/tmp/cierre_meraki_respaldo_%s.json" % datetime.datetime.now().strftime("%H%M%S"), "w"))
    js = ("const xs=%s;let n=0;for(const x of xs){const r=db.alerts.updateOne({alertId:x.alertId,resolvedAt:null},"
          "{$set:{resolvedAt:x.resolvedAt,isTcp:x.isTcp,resolvedVia:'manual:meraki_lookup',reconciledAt:new Date()}});n+=r.modifiedCount}"
          "print(JSON.stringify({cerradas:n}))") % json.dumps(acciones)
    print("cierre aplicado:", ultima_salida(mongo(INST, js)))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Auditoría (SOLO LECTURA) de alarmas RETENIDAS en Helix: compara lo que el
concentrador TCP considera ACTIVO contra el estado real de la alerta en -wh y
en mep3.

Por qué sirve: ms-helix-tcp guarda por alertId la ÚLTIMA trama que envió
(isActive:true = última trama fue una ALARMA; false = fue un CESE). Una alarma
con isActive:true cuya alerta ya está cerrada (o ya no existe) en las apps es,
casi seguro, una alarma retenida en Helix: su cese no salió o se perdió.

Clasifica cada alarma activa del TCP (se ignoran las del guardián, `MW-*`):
  vigente_wh        abierta en -wh (puede ser legítima: el equipo sigue caído;
                    se muestra `lastLookupAt`, la última vez que Meraki la confirmó)
  cerrada_wh        cerrada en -wh pero el TCP la tiene activa -> CESE NO ENTREGADO
  vigente_mep3      solo existe en mep3 y está abierta (no se copió a -wh)
  cerrada_mep3      solo en mep3 y cerrada -> CESE NO ENTREGADO (era de mep3)
  huerfana          no existe en ninguna de las dos bases (anterior a lo copiado)

Además, en el modo global se hace la comparación INVERSA: alertas ABIERTAS de GLPI
en -wh cuya alarma NO está activa en el TCP (alarma silenciada o nunca enviada,
p. ej. por reglas de silencio): se agrupan por tipo.

Con --equipos archivo.txt muestra el estado de ESOS equipos en las tres bases,
tengan o no alarma activa en el TCP. Cada línea: `equipo;dd/mm/aaaa hh:mm:ss`
(la segunda parte es "Fecha y Hora Alarma" de Helix, hora de Costa Rica; es
opcional). Con la hora se identifica LA alerta exacta (inicio ±3 min) y se
diagnostica cada caso:
  abierta_en_wh              la alerta sigue ABIERTA en -wh aunque Meraki ya no la tiene
  cese_pendiente_en_wh       -wh la cerró pero el cese aún no salió hacia el TCP
  cese_no_llego_al_tcp       -wh la cerró y marcó enviada, pero el TCP sigue con la alarma activa
  cese_en_tcp_no_aplicado    el TCP recibió y escribió el CESE, y Helix aun así la conserva
                             (se muestra cuántos segundos pasaron entre alarma y cese)
  sin_coincidencia           ninguna alerta de -wh/mep3 empezó a esa hora

Uso (en el servidor):
  python3 auditar_retenidas_tcp.py
  python3 auditar_retenidas_tcp.py --equipos /tmp/equipos_cliente.txt
"""
import datetime
import json
import sys
from collections import Counter

from migrar_estado_a_wh import M3, WH, mongo, ultima_salida

TCP = ("mongodb-tcp", "ms_helix_tcp", "ms-helix-tcp")
ARCHIVO_EQUIPOS = sys.argv[sys.argv.index("--equipos") + 1] if "--equipos" in sys.argv else None
MAX_LINEAS = 120
CR = datetime.timezone(datetime.timedelta(hours=-6))


def fecha(v):
    if isinstance(v, dict):
        v = v.get("$date")
    if v is None or v == "":
        return None
    return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def equipo(d):
    devs = (d.get("scope") or {}).get("devices") or []
    return devs[0].get("name") if devs else None


def clasificar(tcp_activos, wh, m3):
    """Función pura. tcp_activos: docs del TCP con isActive true. wh/m3: dict alertId -> doc."""
    res = []
    for t in tcp_activos:
        aid = t["alertId"]
        if aid.startswith("MW-"):
            continue
        w, m = wh.get(aid), m3.get(aid)
        if w is not None:
            cat = "vigente_wh" if not w.get("resolvedAt") else "cerrada_wh"
        elif m is not None:
            cat = "vigente_mep3" if not m.get("resolvedAt") else "cerrada_mep3"
        else:
            cat = "huerfana"
        res.append({"cat": cat, "alertId": aid, "eq": t.get("nombreEquipo"), "tcp": t, "wh": w, "m3": m})
    return res


def edad_dias(t, ahora):
    f = fecha(t.get("createdAt"))
    return round((ahora - f).total_seconds() / 86400, 1) if f else None


def consulta_tcp(js_filtro):
    proy = "{_id:0,alertId:1,nombreEquipo:1,evento:1,severidadEvento:1,isActive:1,isTcpSent:1,createdAt:1,updatedAt:1,nombreCliente:1}"
    return json.loads(ultima_salida(mongo(TCP, "print(EJSON.stringify(db.alerts.find(%s,%s).toArray(),{relaxed:true}))" % (js_filtro, proy))))


def consulta_app(inst, js_filtro):
    proy = "{_id:0,alertId:1,type:1,startedAt:1,resolvedAt:1,isTcp:1,isGlpi:1,lastLookupAt:1,resolvedVia:1,updatedAt:1,'scope.devices.name':1}"
    return json.loads(ultima_salida(mongo(inst, "print(EJSON.stringify(db.alerts.find(%s,%s).toArray(),{relaxed:true}))" % (js_filtro, proy))))


def por_ids(inst, ids):
    if not ids:
        return {}
    return {d["alertId"]: d for d in consulta_app(inst, "{alertId:{$in:%s}}" % json.dumps(ids))}


def resumen_app(d):
    if d is None:
        return "no existe"
    estado = "ABIERTA" if not d.get("resolvedAt") else "cerrada " + str(d["resolvedAt"])[:19]
    extra = ""
    if d.get("resolvedVia"):
        extra += f" via={d['resolvedVia']}"
    if not d.get("resolvedAt") and d.get("lastLookupAt"):
        extra += f" ult_verif_meraki={fecha(d['lastLookupAt']).strftime('%m-%d %H:%M')}"
    return f"{estado} tcp={d.get('isTcp')}{extra}"


def leer_equipos(ruta):
    """Líneas `equipo` o `equipo;dd/mm/aaaa hh:mm:ss` (hora CR). Devuelve [(nombre, alarma_utc|None)]."""
    salida = []
    for linea in open(ruta, encoding="utf-8"):
        linea = linea.strip()
        if not linea:
            continue
        nombre, _, f = linea.partition(";")
        alarma = None
        if f.strip():
            alarma = datetime.datetime.strptime(f.strip(), "%d/%m/%Y %H:%M:%S").replace(tzinfo=CR).astimezone(datetime.timezone.utc)
        salida.append((nombre.strip(), alarma))
    return salida


def buscar_coincidente(docs, nombre, alarma_utc, tolerancia_s=180):
    """La alerta de ese equipo cuyo inicio está a menos de 3 min de la hora de la alarma."""
    if alarma_utc is None:
        return None
    cand = [d for d in docs if equipo(d) == nombre and d.get("startedAt")
            and abs((fecha(d["startedAt"]) - alarma_utc).total_seconds()) <= tolerancia_s]
    return min(cand, key=lambda d: abs((fecha(d["startedAt"]) - alarma_utc).total_seconds())) if cand else None


def diagnosticar(nombre, alarma_utc, wh_docs, m3_docs, tcp_por_id):
    """Función pura: devuelve dict con la categoría y los datos que la sustentan."""
    w = buscar_coincidente(wh_docs, nombre, alarma_utc)
    m = buscar_coincidente(m3_docs, nombre, alarma_utc)
    base = w or m
    r = {"eq": nombre, "alertId": base["alertId"] if base else None, "en": "-wh" if w else ("mep3" if m else None), "wh": w, "m3": m, "tcp": None, "gap_s": None, "dur_min": None}
    if base is None:
        r["cat"] = "sin_coincidencia"
        return r
    t = tcp_por_id.get(base["alertId"])
    r["tcp"] = t
    if base.get("resolvedAt") and base.get("startedAt"):
        r["dur_min"] = round((fecha(base["resolvedAt"]) - fecha(base["startedAt"])).total_seconds() / 60, 1)
    if t is not None and fecha(t.get("createdAt")) and fecha(t.get("updatedAt")):
        r["gap_s"] = round((fecha(t["updatedAt"]) - fecha(t["createdAt"])).total_seconds())
    if not base.get("resolvedAt"):
        r["cat"] = "abierta_en_wh" if w else "abierta_en_mep3"
    elif base.get("isTcp") is False:
        r["cat"] = "cese_pendiente_en_wh" if w else "cese_pendiente_en_mep3"
    elif t is None:
        r["cat"] = "sin_registro_en_tcp"
    elif t.get("isActive"):
        r["cat"] = "cese_no_llego_al_tcp"
    else:
        r["cat"] = "cese_en_tcp_no_aplicado"
    return r


def alarmas_no_activas(abiertas_wh, tcp_activos_ids):
    """Función pura: alertas abiertas de GLPI en -wh cuya alarma no está activa en el TCP."""
    return [a for a in abiertas_wh if a["alertId"] not in tcp_activos_ids]


def main_global():
    ahora = datetime.datetime.now(datetime.timezone.utc)
    activos = consulta_tcp("{isActive:true}")
    ids = [t["alertId"] for t in activos if not t["alertId"].startswith("MW-")]
    wh = por_ids(WH, ids)
    m3 = por_ids(M3, [i for i in ids if i not in wh])
    res = clasificar(activos, wh, m3)
    print(f"alarmas ACTIVAS en el TCP (sin las del guardián): {len(res)}")
    print("por categoría:", dict(Counter(r["cat"] for r in res)))
    retenidas = [r for r in res if r["cat"] in ("cerrada_wh", "cerrada_mep3", "huerfana")]
    print(f"\nRETENIDAS probables (cese no entregado o sin dueño): {len(retenidas)}")
    por_cliente = Counter((r["tcp"].get("nombreCliente") or "?") for r in retenidas)
    print("  por cliente:", dict(por_cliente))
    for r in sorted(retenidas, key=lambda x: str(x["tcp"].get("createdAt")))[:MAX_LINEAS]:
        t = r["tcp"]
        print(f"  [{r['cat']}] {r['eq']} | {t.get('evento','')[:40]} | edad={edad_dias(t, ahora)}d | -wh: {resumen_app(r['wh'])} | mep3: {resumen_app(r['m3'])}")
    if len(retenidas) > MAX_LINEAS:
        print(f"  ... y {len(retenidas) - MAX_LINEAS} más")
    # Comparación inversa: abiertas de GLPI en -wh que el TCP NO tiene como alarma activa.
    abiertas = consulta_app(WH, "{resolvedAt:null,isGlpi:true}")
    activos_ids = {t["alertId"] for t in activos}
    sin_alarma = alarmas_no_activas(abiertas, activos_ids)
    print(f"\nabiertas de GLPI en -wh: {len(abiertas)} | sin alarma activa en el TCP (silenciadas o nunca enviadas): {len(sin_alarma)}")
    print("  por tipo:", dict(Counter(a.get("type") for a in sin_alarma)))
    print("  de ellas marcadas como enviadas en -wh (isTcp:true):", sum(1 for a in sin_alarma if a.get("isTcp")))
    for a in sorted(sin_alarma, key=lambda x: str(x.get("startedAt")))[:25]:
        print(f"    {equipo(a)} {a.get('type')} ini={str(a.get('startedAt'))[:19]} isTcp={a.get('isTcp')}")
    vig = [r for r in res if r["cat"] in ("vigente_wh", "vigente_mep3")]
    viejas = sorted(vig, key=lambda x: str(x["tcp"].get("createdAt")))[:30]
    print(f"\nVIGENTES (abiertas en las apps): {len(vig)}. Las 30 más antiguas, con su última verificación contra Meraki:")
    for r in viejas:
        t = r["tcp"]
        print(f"  [{r['cat']}] {r['eq']} | edad={edad_dias(t, ahora)}d | -wh: {resumen_app(r['wh'])}")


def main_equipos(ruta):
    pares = leer_equipos(ruta)
    nombres = sorted({n for n, _ in pares})
    ahora = datetime.datetime.now(datetime.timezone.utc)
    tcp = consulta_tcp("{nombreEquipo:{$in:%s}}" % json.dumps(nombres))
    wh = consulta_app(WH, "{'scope.devices.name':{$in:%s}}" % json.dumps(nombres))
    m3 = consulta_app(M3, "{'scope.devices.name':{$in:%s}}" % json.dumps(nombres))
    tcp_por_id = {t["alertId"]: t for t in tcp}
    diag = [diagnosticar(n, a, wh, m3, tcp_por_id) for n, a in pares]
    print(f"equipos del cliente: {len(pares)}")
    print("diagnóstico:", dict(Counter(d["cat"] for d in diag)))
    gaps = sorted(d["gap_s"] for d in diag if d["gap_s"] is not None and d["cat"] == "cese_en_tcp_no_aplicado")
    if gaps:
        print(f"segundos entre la creación y la última actualización del documento en el TCP (casos cese_en_tcp_no_aplicado): min={gaps[0]} mediana={gaps[len(gaps)//2]} max={gaps[-1]}")
    durs = sorted(d["dur_min"] for d in diag if d["dur_min"] is not None)
    if durs:
        print(f"duración de la alerta (inicio -> cierre, min): min={durs[0]} mediana={durs[len(durs)//2]} max={durs[-1]}")
    print()
    for d in sorted(diag, key=lambda x: x["cat"]):
        t = d["tcp"] or {}
        w, m = d["wh"], d["m3"]
        print(f"[{d['cat']}] {d['eq']} alerta={d['alertId']} en={d['en']} dur={d['dur_min']}min tcp_marcado_enviado_tras={d['gap_s']}s "
              f"| tcp activa={t.get('isActive')} | -wh: {resumen_app(w)} | mep3: {resumen_app(m)}")


if __name__ == "__main__":
    if ARCHIVO_EQUIPOS:
        main_equipos(ARCHIVO_EQUIPOS)
    else:
        main_global()

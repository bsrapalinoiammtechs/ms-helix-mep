#!/usr/bin/env python3
"""
Auditoría (SOLO LECTURA) de la ventana en que mep3 y -wh corrieron a la vez.

Contexto (13-oct-2026): tras la copia de estado a -wh, la app de mep3 volvió a
arrancar (20:03:31Z) y estuvo hasta las 22:55:34Z. En ese tiempo los dos
hicieron polling y enviaron a Helix. Helix identifica por NOMBRE de equipo y un
cese cierra TODAS las alarmas de ese equipo; por eso un cese que sale dos veces
puede cerrar una alarma NUEVA del mismo equipo.

Qué reporta, comparando la base de -wh con la de mep3 (ambas solo se leen):
  - cese_doble:      alerta cerrada en las dos bases y enviada por las dos
                     (el cese salió dos veces a Helix);
  - alarma_doble:    alerta creada en -wh durante la ventana que mep3 ya había
                     enviado (la alarma salió dos veces);
  - estado_distinto: cerrada en una base y abierta en la otra (típico: mep3 la
                     cerró durante la ventana y -wh todavía la ve abierta; -wh
                     mandará un cese duplicado cuando la concilie).
  - En cada cese_doble se buscan alertas ABIERTAS del mismo equipo, en -wh, con
    inicio POSTERIOR al cierre: son las alarmas que ese cese repetido pudo
    cerrar por error en Helix.

Uso (en el servidor, en la carpeta tools de mep3 o -wh):
  python3 auditar_ventana_paralelo.py
  python3 auditar_ventana_paralelo.py --desde 2026-10-13T20:03:00Z
"""
import datetime
import json
import sys
from collections import Counter

from migrar_estado_a_wh import M3, WH, mongo, ultima_salida

DESDE = sys.argv[sys.argv.index("--desde") + 1] if "--desde" in sys.argv else "2026-10-13T20:03:00Z"


def fecha(v):
    """Acepta EJSON ({'$date': ...}), texto ISO o None; devuelve datetime con zona o None."""
    if isinstance(v, dict):
        v = v.get("$date")
    if v is None or v == "":
        return None
    return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def equipo(d):
    devs = (d.get("scope") or {}).get("devices") or []
    return devs[0].get("name") if devs else None


def analizar(wh_docs, m3_docs, wh_abiertas):
    """Función pura. wh_docs/m3_docs: listas de alertas; wh_abiertas: alertas abiertas de -wh.
    Devuelve dict con las categorías y, por cese doble, las alarmas abiertas posteriores."""
    m3 = {d["alertId"]: d for d in m3_docs}
    res = {"cese_doble": [], "alarma_doble": [], "estado_distinto": [], "solo_wh": 0}
    for d in wh_docs:
        m = m3.get(d["alertId"])
        if m is None:
            res["solo_wh"] += 1
            continue
        if not (m.get("isGlpi") is True and m.get("isTcp") is True):
            continue
        cerrada_wh, cerrada_m3 = bool(d.get("resolvedAt")), bool(m.get("resolvedAt"))
        if cerrada_wh and cerrada_m3:
            fin = fecha(d["resolvedAt"])
            riesgo = [
                a["alertId"]
                for a in wh_abiertas
                if equipo(a) == equipo(d) and a["alertId"] != d["alertId"]
                and fecha(a.get("startedAt")) is not None and fin is not None and fecha(a["startedAt"]) > fin
            ]
            res["cese_doble"].append({"alertId": d["alertId"], "eq": equipo(d), "fin": d["resolvedAt"], "alarmas_abiertas_posteriores": riesgo})
        elif not cerrada_wh and not cerrada_m3:
            res["alarma_doble"].append({"alertId": d["alertId"], "eq": equipo(d)})
        else:
            res["estado_distinto"].append({"alertId": d["alertId"], "eq": equipo(d), "cerrada_en": "mep3" if cerrada_m3 else "-wh"})
    return res


def main():
    print(f"auditando desde {DESDE}...", flush=True)
    filtro = ('{isGlpi:true,isTcp:true,$or:[{createdAt:{$gte:new Date("%s")}},'
              '{resolvedAt:{$ne:null},updatedAt:{$gte:new Date("%s")}}]}') % (DESDE, DESDE)
    proy = "{_id:0,alertId:1,type:1,startedAt:1,resolvedAt:1,createdAt:1,updatedAt:1,isGlpi:1,isTcp:1,'scope.devices.name':1}"
    wh_docs = json.loads(ultima_salida(mongo(WH, "print(EJSON.stringify(db.alerts.find(%s,%s).toArray(),{relaxed:true}))" % (filtro, proy))))
    ids = [d["alertId"] for d in wh_docs]
    m3_docs = json.loads(ultima_salida(mongo(M3, "const ids=%s; print(EJSON.stringify(db.alerts.find({alertId:{$in:ids}},%s).toArray(),{relaxed:true}))" % (json.dumps(ids), proy))))
    equipos = sorted({equipo(d) for d in wh_docs if equipo(d)})
    wh_abiertas = json.loads(ultima_salida(mongo(WH, "const eq=%s; print(EJSON.stringify(db.alerts.find({resolvedAt:null,isGlpi:true,'scope.devices.name':{$in:eq}},%s).toArray(),{relaxed:true}))" % (json.dumps(equipos), proy))))
    res = analizar(wh_docs, m3_docs, wh_abiertas)

    print(f"alertas de -wh tocadas en la ventana (GLPI, enviadas): {len(wh_docs)} | de ellas, solo existen en -wh: {res['solo_wh']}")
    print(f"cese_doble: {len(res['cese_doble'])} | alarma_doble: {len(res['alarma_doble'])} | estado_distinto: {len(res['estado_distinto'])}")
    print("estado_distinto por lado cerrado:", dict(Counter(x["cerrada_en"] for x in res["estado_distinto"])))
    en_riesgo = [c for c in res["cese_doble"] if c["alarmas_abiertas_posteriores"]]
    print(f"\nceses dobles con una alarma ABIERTA posterior del mismo equipo (posible cierre por error en Helix): {len(en_riesgo)}")
    for c in en_riesgo[:50]:
        print(f"  {c['eq']}: cese de {c['alertId']} ({c['fin']}) -> abiertas posteriores {c['alarmas_abiertas_posteriores']}")
    if len(en_riesgo) > 50:
        print(f"  ... y {len(en_riesgo) - 50} más")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Habilita applianceDown / switchDown / gatewayDown en las redes que los tienen
apagados, con destino aislado SOLO al receiver del webhook (sin correos, sin
SNMP, allAdmins:false) -- el mismo criterio de `enableAlertTypes` de
utils/alertSettingsPlan.ts, pero sin pasar por el gateway de 18 s del
aprovisionamiento (que para 116 redes tarda horas).

Contexto (5-oct-2026): en el primer rollout de las 861 redes solo se agregó el
receiver; los tipos de alerta quedaron como ya estaban. La auditoría encontró
116 de 864 redes no vinculadas con algún tipo de caída apagado: en esas redes
el webhook nunca se dispara por una caída.

Uso (corre en el servidor, lee TOKEN_CISCO del contenedor ms-helix-mep-wh):
  python3 enable_down_types.py                       # PRUEBA: no escribe nada
  python3 enable_down_types.py --aplicar --limite 3  # piloto en 3 redes
  python3 enable_down_types.py --aplicar             # todas las de la lista
  python3 enable_down_types.py --revertir            # restaura los respaldos

Seguridad:
  - Solo toca los tipos de NEED que estén deshabilitados; no cambia
    defaultDestinations ni ningún otro tipo.
  - No crea receivers: si la red no tiene el receiver, la omite.
  - Antes de escribir guarda los ajustes originales en BACKUP/<red>.json.
  - Después de escribir vuelve a leer y verifica.
  - Es idempotente: repetirlo no cambia lo que ya está bien.
"""
import collections
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ORG = "846353"
NEED = ["applianceDown", "switchDown", "gatewayDown"]
RECEIVER_PATH = "/webhooks/meraki/alerts"
LISTA = "/tmp/sin_down.txt"  # id<TAB>nombre<TAB>faltan=[...], generado por la auditoría
BACKUP = "/tmp/enable_down_backup"
PAUSA = 0.4

APLICAR = "--aplicar" in sys.argv
REVERTIR = "--revertir" in sys.argv
LIMITE = int(sys.argv[sys.argv.index("--limite") + 1]) if "--limite" in sys.argv else None


def token():
    out = subprocess.run(
        "docker exec ms-helix-mep-wh printenv TOKEN_CISCO",
        shell=True, capture_output=True, text=True,
    ).stdout.strip()
    if not out:
        sys.exit("No se pudo leer TOKEN_CISCO del contenedor ms-helix-mep-wh")
    return out


TOK = None


def call(method, path, body=None):
    global TOK
    if TOK is None:
        TOK = token()
    data = json.dumps(body).encode() if body is not None else None
    for _ in range(6):
        req = urllib.request.Request(
            "https://api.meraki.com/api/v1" + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After", 5)) + 1)
                continue
            return {"_error": e.code, "_body": e.read()[:300].decode("utf-8", "replace")}
    return {"_error": 429}


def with_receiver(alert, to_enable, receiver_id):
    """Copia de `alert` habilitada y con destino aislado al receiver."""
    new = json.loads(json.dumps(alert))
    if new["type"] in to_enable:
        dest = dict(new.get("alertDestinations") or {})
        ids = list(dict.fromkeys((dest.get("httpServerIds") or []) + [receiver_id]))
        dest.update({"emails": [], "snmp": False, "allAdmins": False, "httpServerIds": ids})
        new["enabled"] = True
        new["alertDestinations"] = dest
    return new


def plan(current, receiver_id):
    """Devuelve (tipos a habilitar, tipos que no existen en la red, body nuevo)."""
    alerts = current.get("alerts", [])
    catalog = {a["type"]: a for a in alerts}
    to_enable = [t for t in NEED if t in catalog and catalog[t].get("enabled") is not True]
    no_disponibles = [t for t in NEED if t not in catalog]
    body = dict(current)
    body["alerts"] = [with_receiver(a, to_enable, receiver_id) for a in alerts]
    return to_enable, no_disponibles, body


def verificar(settings, to_enable, receiver_id):
    by_type = {a["type"]: a for a in settings.get("alerts", [])} if isinstance(settings, dict) else {}
    return all(
        by_type.get(t, {}).get("enabled") is True
        and receiver_id in (by_type.get(t, {}).get("alertDestinations") or {}).get("httpServerIds", [])
        for t in to_enable
    )


def revertir():
    if not os.path.isdir(BACKUP):
        sys.exit(f"No existe {BACKUP}: no hay nada que revertir")
    stats = collections.Counter()
    for f in sorted(os.listdir(BACKUP)):
        net = f[:-5]
        res = call("PUT", f"/networks/{net}/alerts/settings", json.load(open(os.path.join(BACKUP, f))))
        time.sleep(PAUSA)
        stats["error" if "_error" in res else "revertida"] += 1
        print(net, "ERROR" if "_error" in res else "revertida")
    print("RESUMEN:", dict(stats))


def main():
    if REVERTIR:
        return revertir()
    ids = [l.split("\t")[0] for l in open(LISTA).read().splitlines() if l.strip()]
    if LIMITE:
        ids = ids[:LIMITE]
    if APLICAR:
        os.makedirs(BACKUP, exist_ok=True)
    print("MODO:", "APLICAR" if APLICAR else "PRUEBA (no escribe nada)", "| redes:", len(ids), flush=True)
    stats = collections.Counter()
    for n in ids:
        cur = call("GET", f"/networks/{n}/alerts/settings")
        time.sleep(PAUSA)
        if "_error" in cur:
            stats["error_lectura"] += 1
            print(n, "error leyendo ajustes", cur, flush=True)
            continue
        servers = call("GET", f"/networks/{n}/webhooks/httpServers")
        time.sleep(PAUSA)
        rid = None
        if isinstance(servers, list):
            rid = next((s["id"] for s in servers if RECEIVER_PATH in s.get("url", "")), None)
        if not rid:
            stats["sin_receptor"] += 1
            print(n, "SIN receptor: no se toca", flush=True)
            continue
        to_enable, no_disp, body = plan(cur, rid)
        extra = f" | no disponibles en la red: {no_disp}" if no_disp else ""
        if not to_enable:
            stats["nada_que_hacer"] += 1
            print(n, "nada que hacer" + extra, flush=True)
            continue
        print(n, "habilitar", to_enable, extra, flush=True)
        if not APLICAR:
            stats["a_cambiar"] += 1
            continue
        json.dump(cur, open(os.path.join(BACKUP, f"{n}.json"), "w"))
        res = call("PUT", f"/networks/{n}/alerts/settings", body)
        time.sleep(PAUSA)
        if "_error" in res:
            stats["error_escritura"] += 1
            print("    ERROR al escribir", res, flush=True)
            continue
        ok = verificar(call("GET", f"/networks/{n}/alerts/settings"), to_enable, rid)
        time.sleep(PAUSA)
        stats["aplicada_ok" if ok else "aplicada_revisar"] += 1
        print("    ", "OK verificada" if ok else "REVISAR: la lectura posterior no coincide", flush=True)
    print("RESUMEN:", dict(stats), flush=True)


if __name__ == "__main__":
    main()

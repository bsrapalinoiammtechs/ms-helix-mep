#!/usr/bin/env python3
"""
Vigilancia (SOLO LECTURA) de alarmas RETENIDAS en todas las organizaciones.
Pensado para correr por cron en el servidor (cada 15 min). No escribe en ninguna base.

Por cada contenedor `ms-helix-<org>` (menos tcp, zabbix y mep3, que está inerte) lee de SU entorno
la conexión (`MONGO_DB`) y compara con el concentrador TCP (`ms_helix_tcp`):
  retenidas    alertas CERRADAS en la organización (últimos 14 días, cerradas hace más de 30 min)
               cuya alarma sigue ACTIVA en el TCP -> el cese no llegó.
  sin_alarma   alertas ABIERTAS de GLPI marcadas como enviadas (isTcp:true) cuya alarma NO está
               activa en el TCP -> la alarma nunca salió o ya se cesó.
  pendientes   alertas de GLPI con isTcp:false desde hace más de 30 min (no se están enviando,
               p. ej. sin regla de catálogo). Solo informativo.
Avisa (código de salida 2 y, con --notificar, un correo) cuando una misma alerta sigue en
`retenidas` o `sin_alarma` en DOS corridas seguidas (así no avisa por entregas en curso).
Estado entre corridas: /var/tmp/vigilar_retenidas_estado.json

Uso:
  python3 vigilar_retenidas.py                       # todas las organizaciones, imprime el resumen
  python3 vigilar_retenidas.py --solo ms-helix-acs2  # una organización
  python3 vigilar_retenidas.py --notificar http://localhost:8025/notificar --destinatarios a@x.com,b@y.com
Cron (cada 15 min):
  */15 * * * * /usr/bin/python3 /home/pbs/ms-helix-mep-wh/tools/vigilar_retenidas.py --notificar ... >> /var/log/vigilar_retenidas.log 2>&1
"""
import datetime
import json
import re
import subprocess
import sys
import urllib.request

ESTADO = "/var/tmp/vigilar_retenidas_estado.json"
EXCLUIDOS = {"ms-helix-tcp", "ms-helix-zabbix", "ms-helix-mep"}
GRACIA_MIN = 30
VENTANA_DIAS = 14
TCP_URI = "mongodb://andrair:1234@localhost:27017/ms_helix_tcp?authSource=admin"


def argval(flag, defecto=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else defecto


def sh(cmd, entrada=None):
    return subprocess.run(cmd, capture_output=True, text=True, input=entrada)


def mongo(contenedor, uri, js):
    """Ejecuta JS en mongosh del contenedor con --file (sin indicador interactivo)."""
    ruta = "/tmp/_vigilar.js"
    w = sh(["docker", "exec", "-i", contenedor, "sh", "-c", f"cat > {ruta}"], js)
    if w.returncode != 0:
        raise RuntimeError(f"no pude escribir el script en {contenedor}: {w.stderr[:200]}")
    try:
        p = sh(["docker", "exec", contenedor, "mongosh", uri, "--quiet", "--file", ruta])
    finally:
        sh(["docker", "exec", contenedor, "rm", "-f", ruta])
    if p.returncode != 0:
        raise RuntimeError(f"mongosh en {contenedor}: {p.stderr[:200] or p.stdout[:200]}")
    return p.stdout


def ultima_json(out):
    for linea in reversed(out.strip().splitlines()):
        l = re.sub(r"^[\w.\-]+>\s*", "", linea.strip())
        if l and l[0] in "[{":
            return json.loads(l)
    raise RuntimeError(f"sin salida utilizable: {out[-200:]}")


def uri_local(uri):
    """La conexión de la app apunta al servicio por nombre; dentro del contenedor de Mongo es localhost."""
    m = re.match(r"^(mongodb://[^@]+@)[^/]+(/.*)$", uri.strip().strip('"'))
    if not m:
        raise ValueError("MONGO_DB con formato inesperado")
    return m.group(1) + "localhost:27017" + m.group(2)


def organizaciones():
    nombres = sh(["docker", "ps", "--format", "{{.Names}}"]).stdout.split()
    return sorted(n for n in nombres if n.startswith("ms-helix-") and n not in EXCLUIDOS)


def evaluar(cerradas, abiertas, pendientes_viejos, tcp_docs):
    """Función pura. cerradas/abiertas: listas de alertId; tcp_docs: {alertId: {'isActive': bool}}.
    Devuelve (retenidas, sin_alarma, n_pendientes)."""
    retenidas = sorted(a for a in cerradas if tcp_docs.get(a, {}).get("isActive") is True)
    sin_alarma = sorted(a for a in abiertas if tcp_docs.get(a, {}).get("isActive") is not True)
    return retenidas, sin_alarma, pendientes_viejos


def persistentes(actual, previo):
    """Función pura: ids presentes en dos corridas seguidas."""
    return sorted(set(actual) & set(previo or []))


def revisar(app):
    slug = app[len("ms-helix-"):]
    mongo_cont = f"mongodb-helix-{slug}"
    uri = uri_local(sh(["docker", "exec", app, "printenv", "MONGO_DB"]).stdout)
    ahora = datetime.datetime.now(datetime.timezone.utc)
    corte_gracia = (ahora - datetime.timedelta(minutes=GRACIA_MIN)).strftime("%Y-%m-%dT%H:%M:%SZ")
    desde = (ahora - datetime.timedelta(days=VENTANA_DIAS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    js = ('const c=db.alerts.find({isGlpi:true,isTcp:true,resolvedAt:{$ne:null,$gte:"%s",$lte:"%s"}},{_id:0,alertId:1}).toArray().map(a=>a.alertId);'
          'const a=db.alerts.find({isGlpi:true,isTcp:true,resolvedAt:null},{_id:0,alertId:1}).toArray().map(a=>a.alertId);'
          'const p=db.alerts.countDocuments({isGlpi:true,isTcp:false,updatedAt:{$lte:new Date("%s")}});'
          'print(JSON.stringify({cerradas:c,abiertas:a,pendientes:p}))') % (desde, corte_gracia, corte_gracia)
    d = ultima_json(mongo(mongo_cont, uri, js))
    ids = d["cerradas"] + d["abiertas"]
    tcp = {}
    for i in range(0, len(ids), 2000):
        js2 = ('const ids=%s;print(JSON.stringify(db.alerts.find({alertId:{$in:ids}},{_id:0,alertId:1,isActive:1}).toArray()))') % json.dumps(ids[i:i + 2000])
        for t in ultima_json(mongo("mongodb-tcp", TCP_URI, js2)):
            tcp[t["alertId"]] = t
    return evaluar(d["cerradas"], d["abiertas"], d["pendientes"], tcp)


def notificar(url, destinatarios, asunto, mensaje):
    cuerpo = {"asunto": asunto, "mensaje": mensaje}
    if destinatarios:
        cuerpo["destinatarios"] = destinatarios
    req = urllib.request.Request(url, data=json.dumps(cuerpo).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=30).read()


def main():
    solo = argval("--solo")
    try:
        previo = json.load(open(ESTADO))
    except Exception:
        previo = {}
    nuevo, avisos = {}, []
    for app in ([solo] if solo else organizaciones()):
        try:
            ret, sin, pend = revisar(app)
        except Exception as e:
            print(f"{app} | ERROR al revisar: {e}")
            avisos.append(f"{app}: no se pudo revisar ({e})")
            continue
        per_ret = persistentes(ret, previo.get(app, {}).get("retenidas"))
        per_sin = persistentes(sin, previo.get(app, {}).get("sin_alarma"))
        nuevo[app] = {"retenidas": ret, "sin_alarma": sin}
        print(f"{app} | retenidas={len(ret)} (persistentes {len(per_ret)}) | sin_alarma={len(sin)} (persistentes {len(per_sin)}) | pendientes_viejos={pend}")
        if per_ret:
            avisos.append(f"{app}: {len(per_ret)} alarma(s) RETENIDA(S) en Helix (alerta cerrada, cese no entregado). Ej.: {', '.join(per_ret[:3])}")
        if per_sin:
            avisos.append(f"{app}: {len(per_sin)} alerta(s) abierta(s) SIN alarma activa en el TCP. Ej.: {', '.join(per_sin[:3])}")
    if not solo:
        json.dump(nuevo, open(ESTADO, "w"))
    if avisos:
        print("\nAVISOS:\n  " + "\n  ".join(avisos))
        if "--notificar" in sys.argv:
            dest = [d for d in (argval("--destinatarios", "") or "").split(",") if d.strip()]
            try:
                notificar(argval("--notificar"), dest, "[Helix] Alarmas retenidas detectadas", "\n".join(avisos))
                print("correo enviado")
            except Exception as e:
                print(f"no pude enviar el correo: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()

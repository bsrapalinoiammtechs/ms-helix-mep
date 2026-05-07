#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
find_bad_names_list.py
----------------------
Lee un .log (JSON o pseudo-JSON) de alertas y devuelve SOLO una lista con los
nombres de equipo "errados" (con espacios al inicio/fin o múltiples espacios internos).

Uso:
  python find_bad_names_list.py archivo.log [--out salida.txt] [--json]

Por defecto imprime una lista simple (una línea por nombre) sin repetir nombres.
Si pasas --json, imprime un array JSON de strings.
"""

import argparse
import json
import re
import sys
from typing import Any, Dict, Iterable, List, Optional

def try_load_json_array(text: str) -> Optional[List[Dict[str, Any]]]:
    text_strip = text.strip()
    if not text_strip:
        return []
    try:
        data = json.loads(text_strip)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict):
            return [data]
    except Exception:
        pass
    # Intento adicional: envolver entre corchetes
    try:
        t2 = text_strip[:-1] if text_strip.endswith(",") else text_strip
        data = json.loads(f"[{t2}]")
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
    except Exception:
        return None
    return None

def extract_json_objects(text: str) -> List[Dict[str, Any]]:
    objs: List[Dict[str, Any]] = []
    in_str = False
    esc = False
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        else:
            if ch == '"':
                in_str = True
                continue
            if ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    candidate = text[start:i+1]
                    try:
                        obj = json.loads(candidate)
                        if isinstance(obj, dict):
                            objs.append(obj)
                    except Exception:
                        pass
                    start = None
    return objs

def load_log_objects(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    arr = try_load_json_array(content)
    if arr is not None:
        return arr
    return extract_json_objects(content)

def iter_device_names(obj: Dict[str, Any]) -> Iterable[str]:
    scope = obj.get("scope", {}) or {}
    devices = scope.get("devices", []) or []
    for d in devices:
        if isinstance(d, dict):
            name = d.get("name")
            if isinstance(name, str):
                yield name

def is_bad_name(name: str) -> bool:
    # Espacios al inicio/fin
    if name != name.strip():
        return True
    # Múltiples espacios internos
    if re.search(r"\s{2,}", name.strip()):
        return True
    return False

def unique_preserve_order(seq: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out

def main():
    ap = argparse.ArgumentParser(description="Extrae solo los nombres de dispositivos con espacios erróneos (al inicio/fin o múltiples internos).")
    ap.add_argument("log_path", help="Ruta del archivo .log a analizar")
    ap.add_argument("--out", help="Ruta de salida (txt o json si usas --json)", default=None)
    ap.add_argument("--json", action="store_true", help="Imprime como JSON (array de strings) en lugar de líneas")
    args = ap.parse_args()

    try:
        objs = load_log_objects(args.log_path)
    except FileNotFoundError:
        print(f"ERROR: no existe el archivo: {args.log_path}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR al leer/procesar: {e}", file=sys.stderr)
        sys.exit(1)

    names: List[str] = []
    for o in objs:
        for name in iter_device_names(o):
            if is_bad_name(name):
                names.append(name)

    names = unique_preserve_order(names)

    if args.json:
        output = json.dumps(names, ensure_ascii=False, indent=2)
    else:
        output = "\n".join(names)

    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(output + ("\n" if not args.json else ""))
            print(f"✅ Guardado en: {args.out}")
        except Exception as e:
            print(f"ERROR escribiendo salida: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(output)

if __name__ == "__main__":
    main()
#python3 spacesName.py todas.log --out malos.json o malos.txt
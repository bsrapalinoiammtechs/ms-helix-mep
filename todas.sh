#!/usr/bin/env bash

TOKEN="ae426db18fdabd716363a33a75f6b617f3079e3f"
ORG="846353"
BASE="https://api.meraki.com/api/v1/organizations/${ORG}/assurance/alerts"
PERPAGE=300

# Empezamos en la primera página
next_url="${BASE}?perPage=${PERPAGE}&sortOrder=descending&resolved=false&active=true"

while [[ -n "$next_url" ]]; do
  # 1) Llamamos al endpoint, separados headers y body
  tmp_h=$(mktemp)
  tmp_b=$(mktemp)
  curl -s -D "$tmp_h" \
       -H "Authorization: Bearer ${TOKEN}" \
       -H "Content-Type: application/json" \
       "$next_url" \
       -o "$tmp_b"

  # 2) Procesamos la página
  count=$(jq '. | length' "$tmp_b")
  echo "Página con $count eventos"
  jq . "$tmp_b"

  # 3) Si vino menos de PERPAGE, ya no hay más
  if (( count < PERPAGE )); then
    break
  fi

  # 4) Sacamos el último ID de esta página y armamos la siguiente URL
  last_id=$(jq -r '.[-1].id' "$tmp_b")
  next_url="${BASE}?perPage=${PERPAGE}&sortOrder=descending&resolved=false&active=true&startingAfter=${last_id}"

  # 5) Limpieza de temporales
  rm "$tmp_h" "$tmp_b"
done

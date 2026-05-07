#!/usr/bin/env bash

# Reiniciar el primer contenedor (ms-helix-mep3)
echo "Reiniciando ms-helix-mep3..."
cd /home/pbs/ms-helix-mep3
docker compose down && docker compose up -d --build

# Reiniciar el segundo contenedor (ms-helix-tcp)
echo "Reiniciando ms-helix-tcp..."
cd /home/pbs/ms-helix-tcp
docker compose down && docker compose up -d

echo "¡Ambos servicios han sido reiniciados exitosamente!"
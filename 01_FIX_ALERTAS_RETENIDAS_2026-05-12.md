# Alertas retenidas — Hallazgos, ejecución y plan
**Fecha:** 2026-05-12
**Sistema:** ms-helix-mep3 + ms-helix-tcp (MEP Costa Rica)

---

## 1. Síntoma reportado

Al ejecutar `REQ_ACT_ALM` desde Helix NMS aparecen alertas que el operador considera resueltas. Ejemplo concreto:

```
IdNotificacion = 3865777330154695584
Fecha-Hora     = 11-05-2026 08:57:16
NombreEquipo   = SAMEP-01SWT001SJ0334
CausaEvento    = Connectivity
Evento         = Equipo fuera del alcance
```

En Meraki esa alerta ya fue resuelta hace horas. El operador reporta que llegó primero la alerta de conectividad, luego una de DNS sin que la primera se resolviera, después el resolve de DNS — pero el resolve de la conectividad nunca llegó al NMS.

---

## 2. Diagnóstico

### 2.1 No hay solapamiento entre alertas

La intuición inicial de que una alerta "solapa" a otra no se cumple a nivel técnico. Los `alertId` son únicos y el upsert en MongoDB usa `alertId` como clave. La alerta DNS (`...07559`) y la de conectividad (`...95584`) son documentos independientes — una no pisa a la otra.

### 2.2 Magnitud real del problema

Conteo directo sobre `ms_helix_mep.alerts` al momento del diagnóstico:

| Métrica | Valor |
|---|---:|
| Activas con `resolvedAt:null, isGlpi:true` | 1,548 |
| Stuck > 6 horas | 463 |
| Stuck > 24 horas | 402 |
| Más vieja "activa" | 2025-09-01 (~8 meses) |
| Networks distintos involucrados | 134 |

La alerta `...95584` no es un caso aislado: hay un patrón sistemático.

### 2.3 Verificación contra Cisco

Consulta directa al endpoint con filtro `networkId`:

```
GET /organizations/846353/assurance/alerts
    ?active=false&resolved=true
    &networkId=L_3865777330144150173
    &perPage=300&sortOrder=descending
```

La alerta `...95584` aparece en la primera página con `resolvedAt: 2026-05-11T22:56:05Z`. Cisco sí registró la cesación; el cron de CESE de ms-helix-mep nunca la procesó.

---

## 3. Causa raíz

El servicio `cese.alerts.service.ts` consulta el endpoint **global de la organización** (sin filtro de network):

```typescript
new CiscoAlertsService({
    active: false,
    resolved: true,
    perPage: 300,
    sortOrder: "descending"   // sin sortBy explícito
})
```

Cisco ordena por `startedAt` descendente por defecto. La paginación se detiene cuando una página completa ya está registrada como cesada en MEP DB (scan-until-known).

**Lo que falla:**

1. Una alerta puede empezar hace semanas/meses y resolverse hoy. En orden `startedAt desc` queda en una página profunda del historial — no en página 1.
2. Las primeras páginas contienen alertas con `startedAt` muy reciente; la mayoría ya están registradas como cesadas → el sistema converge en página 2-3 y termina.
3. La alerta resuelta hoy pero con `startedAt` viejo nunca es alcanzada.
4. Cisco aplica rate-limit estricto (1 req/10s, burst 2), así que no es viable "escanear todo siempre".

**Adicional:** el endpoint global tiene un techo de cobertura. La misma alerta que no aparece al paginar el endpoint global SÍ aparece al consultar filtrando por `networkId`. El endpoint por network expone el historial completo del network.

---

## 4. Plan de solución

### FASE A — Reparación inmediata  ✅ COMPLETADA (2026-05-12)

**Objetivo:** dejar la BD consistente con el estado real de Cisco para las alertas stuck recientes (< 30 días), sin tocar código en producción.

#### 4.A.1 Mecanismo

1. Leer de MEP DB todas las alertas con `resolvedAt:null, isGlpi:true, startedAt < hace 1h`.
2. Filtrar las que tienen `startedAt < hace 30 días` (out of scope para esta fase).
3. Agrupar las restantes por `network.id`.
4. Para cada network, consultar Cisco con `?networkId=<id>&active=false&resolved=true&perPage=300` (página 1, las cesaciones más recientes).
5. Cruzar IDs: las stuck que aparezcan en la respuesta de Cisco con `resolvedAt != null` se actualizan en MEP DB con `resolvedAt` real y `isTcp:false`.
6. El cron `validateAndBuildAlertsToSend` (cada 1 min) las despacha al servicio TCP en el siguiente ciclo.
7. `ms-helix-tcp` las envía al NMS Helix como CESE.

**Salvaguardas implementadas:**
- Modo `DRY_RUN=true` por defecto.
- `findOneAndUpdate` filtrado por `{ alertId, resolvedAt: null }` para no pisar cambios concurrentes.
- Respeta `Retry-After` de Cisco en 429 con espera + 2s; **nunca abandona** una página.
- Delay 11s entre llamadas a Cisco (estrictamente < 1 req/10s sustained).
- Filtro por edad: ignora >30 días por defecto.
- Procesa por network → fallo en uno no detiene los demás.

#### 4.A.2 Resultados de la ejecución

```
Total stuck found:        506
In scope (<30d):          332
  → Matched in Cisco:      20   ← reparadas
  → Not found page 1:     312   ← genuinamente activas en Cisco
Out of scope (≥30d):      174   ← Fase A.2
Updated in MEP DB:         20
Elapsed:                   24 min
```

**Verificación end-to-end:**
- MEP DB: alerta `...95584` quedó con `resolvedAt: 2026-05-11T22:56:05Z, isTcp: true`.
- Cron MEP→TCP: `send.cron.summary received=39, tcp_success=39, race_lost=0`.
- TCP→NMS: `sender.summary delivered=39, failed=0, clients=3, claimRace=0`.

Las 312 "not_found" se validaron por muestreo: están como `active=true` en Cisco también (equipos genuinamente caídos). MEP refleja correctamente la realidad operativa — no es bug.

#### 4.A.3 Cómo ejecutarlo manualmente

El script vive en:
- **Host (fuente de verdad):** `/home/pbs/init/fase-a-reconciliacion/reconcile-v2.js`
- **Contenedor:** `/app/reconcile-v2.js` (dentro de `ms-helix-mep`)

Si modificas el script en el host, cópialo al contenedor antes de ejecutar:
```bash
docker cp /home/pbs/init/fase-a-reconciliacion/reconcile-v2.js \
  ms-helix-mep:/app/reconcile-v2.js
```

**Dry-run (solo reporta, no toca BD) — recomendado siempre primero:**
```bash
docker exec -e DRY_RUN=true -e MAX_AGE_DAYS=30 -e RATE_DELAY_MS=11000 \
  -w /app ms-helix-mep node reconcile-v2.js
```

**Aplicar real:**
```bash
docker exec -e DRY_RUN=false -e MAX_AGE_DAYS=30 -e RATE_DELAY_MS=11000 \
  -w /app ms-helix-mep node reconcile-v2.js
```

**En background con log a archivo (recomendado por la duración ~17-25 min):**
```bash
LOG=/home/pbs/init/fase-a-reconciliacion/apply-$(date +%Y%m%d-%H%M%S).log
nohup docker exec -e DRY_RUN=false -e MAX_AGE_DAYS=30 -e RATE_DELAY_MS=11000 \
  -w /app ms-helix-mep node reconcile-v2.js > "$LOG" 2>&1 &
echo "Log: $LOG"
```

**Variables configurables:**

| Variable | Default | Descripción |
|---|---|---|
| `DRY_RUN` | `true` | `false` aplica cambios; `true` solo reporta |
| `MAX_AGE_DAYS` | `30` | Ignora alertas con `startedAt` más antiguo que N días |
| `RATE_DELAY_MS` | `11000` | Delay entre llamadas a Cisco. **No bajar de 11000** |
| `STUCK_HOURS` | `1` | Edad mínima para considerar "stuck" |
| `MAX_NETWORKS` | `999` | Limita cuántos networks procesar (útil para tests) |

#### 4.A.4 Cómo monitorearlo

**Ver el log en vivo:**
```bash
LATEST=$(ls -t /home/pbs/init/fase-a-reconciliacion/apply-*.log | head -1)
tail -f "$LATEST"
```

**Progreso resumido (1 sola query):**
```bash
LATEST=$(ls -t /home/pbs/init/fase-a-reconciliacion/apply-*.log | head -1)
echo "Networks: $(grep -cE '^\[[0-9]+/' $LATEST) / $(grep -oP 'Networks to query:\s+\K\d+' $LATEST)"
echo "Matches:  $(grep -c '^  MATCH' $LATEST)"
echo "429s:     $(grep -c '429, waiting' $LATEST)"
tail -3 "$LATEST"
```

**Confirmar que el proceso sigue corriendo:**
```bash
docker exec ms-helix-mep ps aux | grep "node reconcile-v2" | grep -v grep
```

**Detener el proceso (si fuera necesario):**
```bash
docker exec ms-helix-mep pkill -f reconcile-v2
```

**Resumen final (después de terminar):**
```bash
LATEST=$(ls -t /home/pbs/init/fase-a-reconciliacion/apply-*.log | head -1)
grep -A 20 "^Summary" "$LATEST"
```

#### 4.A.5 Verificación post-apply

```bash
# 1. Stuck remanentes en MEP (debería tender a estabilizarse)
docker exec mongodb-helix-mep mongosh --quiet -u andrair -p 1234 \
  --authenticationDatabase admin ms_helix_mep --eval '
const cutoffHr = new Date(Date.now() - 3600*1000).toISOString();
const cutoff30 = new Date(Date.now() - 30*24*3600*1000).toISOString();
print("stuck <30d, >1h:",
  db.alerts.countDocuments({resolvedAt:null, isGlpi:true,
                            startedAt:{$lt:cutoffHr, $gte:cutoff30}}));
print("pending send:",
  db.alerts.countDocuments({isGlpi:true, isTcp:false}));
'

# 2. Verificación: el cron MEP envió los CESEs al servicio TCP
docker logs ms-helix-mep --since 30m 2>&1 | grep '"send.cron.summary"' | tail -5

# 3. Verificación: TCP entregó al NMS Helix
docker logs ms-helix-tcp --since 30m 2>&1 | grep '"sender.summary"' | tail -5
```

---

### FASE A.2 — Alertas mayores a 30 días  ✅ COMPLETADA (2026-05-13, vía CESE masivo)

> **Decisión operativa final:** se ejecutó la **opción A** (cese masivo con `resolvedAt = now`) para las 174 alertas, en vez de la opción C propuesta originalmente. La distribución previa de "Estrategia escalonada" (Pasos 1–3 abajo) queda como referencia histórica.
>
> **Ejecución (2026-05-13 03:21:44 UTC):**
> - Filtro: `{ startedAt: { $lt: cutoff30 }, resolvedAt: null, isGlpi: true }` → 174 docs
> - Update: `$set: { resolvedAt: "2026-05-13T03:21:44.879Z", isTcp: false }`
> - `MODIFIED=174, MATCHED=174, errors=0`
> - Cron `validateAndBuildAlertsToSend` despachó la siguiente vuelta (03:22:00): `send.cron.summary: received=176, built=176, tcp_success=176, tcp_failed=0`
> - El NMS recibió 176 CESEs (174 viejas + 2 normales)
> - Drift post: `stuck_1h: 462 → 288 (-174)`; `oldest_stuck` pasó de 6080h (2025-09-01) a 680h (2026-04-14, dentro de scope)
>
> **Rationale para elegir opción A vs C:**
> - El operador del NMS necesita un estado limpio para reanudar operación normal; mantener las 174 con flag `expired` (opción C) requería cambios en filtros downstream del NMS que están fuera de alcance.
> - La fecha de cierre artificial (now) es aceptable porque la información real de Cisco ya no existe para estas alertas.
>
> **Salvaguarda — rollback:** `/home/pbs/init/host-backup-cese174-20260513-032144/affected-alerts.json` contiene `[{alertId, startedAt, isTcp:true}]` de las 174. Permite revertir alerta por alerta si se descubre que un equipo realmente estaba caído y el CESE artificial sería incorrecto.

---

**Contexto histórico (pre-cese):** Quedaban **174 alertas** con `startedAt >= 30 días` que la Fase A no procesó. Distribución:

| Rango de edad | Cantidad |
|---|---:|
| 30 – 60 días | 65 |
| 60 – 90 días | 45 |
| 90 – 180 días | 16 |
| > 180 días | 48 |

**Problema central:** Cisco purga su historial de alertas resueltas tras un periodo (estimado 90-180 días). Para muchas de estas alertas, Cisco ya no retornará un `resolvedAt` real porque la información ya no existe en su sistema.

#### 4.A.2.1 Estrategia escalonada

**Paso 1 — Sondeo individual (script `reconcile-old-probe.js`, por crear)**

Para cada una de las 174 alertas, consultar Cisco intentando dos rutas:

1. **Endpoint específico:** `GET /organizations/{org}/assurance/alerts/{alertId}`
   - Si responde 200 con `resolvedAt`: aplicar normalmente.
   - Si responde 404 o no incluye `resolvedAt`: descartar y pasar al paso 2.

2. **Endpoint por network con `sortOrder=ascending`:** `?networkId=<id>&active=false&resolved=true&sortOrder=ascending&perPage=300`
   - Esto pagina por las cesaciones más antiguas del network — donde podrían estar las alertas viejas.
   - Si la alerta aparece en alguna página: aplicar normalmente.

Tiempo estimado: 174 alertas × 11s × 2 endpoints = ~64 min en el peor caso. Aceptable.

**Paso 2 — Clasificación según resultado del sondeo**

Las 174 quedan repartidas en tres categorías:

| Categoría | Acción |
|---|---|
| Recuperables (Cisco devolvió `resolvedAt`) | Aplicar igual que Fase A: `resolvedAt` real, `isTcp:false`, el cron despacha |
| Equipo aún reportado por Cisco pero alerta purgada | Decisión operativa: ver paso 3 |
| Equipo no existe en Cisco (`/devices/{serial}` → 404) | Cesar artificialmente con metadata `expired_reason: "device_removed"` |

**Paso 3 — Decisión operativa para alertas no recuperables con equipo activo**

Hay tres opciones (a definir con el equipo de operaciones del MEP):

| Opción | Pros | Contras |
|---|---|---|
| **A** Cesar con `resolvedAt = now` y marcador `expired_reason: "no_cisco_data"` | Limpia el NMS rápido | Fecha de cierre es artificial |
| **B** Cesar con `resolvedAt = startedAt + 90 días` | Más coherente temporalmente | Sigue siendo artificial |
| **C** Mantenerlas activas y descartarlas del envío al NMS vía flag `expired:true` (no aparecen en `REQ_ACT_ALM`) | No miente sobre la fecha de cierre | El operador del NMS no sabe que existieron |

Recomendación inicial: **opción C** — agrega un campo `expired:true` que el filtro de `REQ_ACT_ALM` excluya, sin tocar `resolvedAt`. Las alertas quedan registradas como "estuvieron activas, no se sabe cuándo se resolvieron, se retiran de la operación". Si más adelante el equipo prefiere otra opción, se cambia.

#### 4.A.2.2 Salvaguardas que debe tener `reconcile-old.js`

- Igual que `reconcile-v2.js`: `DRY_RUN=true` por defecto, `RATE_DELAY_MS>=11000`, sin abandono en 429.
- Reporte detallado: cuántas en cada categoría antes de aplicar.
- Si la opción aplicada es A, B o C: registrar `expired_reason` en el documento para trazabilidad.
- **Confirmación explícita** antes de hacer mass-cese artificial — no actuar solo sobre clasificación automática.

#### 4.A.2.3 Cuándo ejecutarla

Después de:
1. Validación operativa con el equipo del NMS de que las 20 alertas reparadas en Fase A se reflejaron correctamente.
2. Decisión sobre la opción A/B/C del paso 3.

---

### FASE B — Prevención estructural (cambio de código)

**Objetivo:** evitar que la situación vuelva a generarse, sin depender de re-correr scripts.

#### B1. Cron de reconciliación periódica  ✅ COMPLETADA (2026-05-12)

La lógica del wrapper externo se llevó al repo de `ms-helix-mep`. Ya forma parte del código fuente del servicio y se replicará a otros clientes simplemente con el deploy del repositorio.

**Archivos:**

| Archivo | Cambio |
|---|---|
| `src/services/reconciliation.service.ts` | **Nuevo** — clase `ReconciliationService` con `run()`, mutex estático, fetch por network con retry en 429, update atómico `findOneAndUpdate({alertId, resolvedAt:null}, …)` |
| `src/index.ts` | Añadido 4° cron schedule + flag `isProcessingReconciliation`, integrado en `/health.processing.reconciliation` |

**Backup pre-cambio:** `/home/pbs/init/host-backup-fase-b-<timestamp>/index.ts` (solo `index.ts` cambia; `reconciliation.service.ts` es nuevo).

**Variables de entorno** (todas opcionales, con defaults sensatos):

| Variable | Default | Descripción |
|---|---|---|
| `RECONCILIATION_ENABLED` | `true` | Si es `false`, el cron no se programa al arrancar |
| `RECONCILIATION_CRON` | `7 * * * *` | Expresión node-cron (validada al arranque) |
| `RECONCILIATION_MAX_AGE_DAYS` | `30` | Alertas con `startedAt` más antiguo quedan fuera de scope |
| `RECONCILIATION_RATE_DELAY_MS` | `11000` | Delay entre llamadas a Cisco (≥10 s, sustained limit) |
| `RECONCILIATION_STUCK_HOURS` | `1` | Edad mínima para entrar al pool |
| `RECONCILIATION_MAX_NETWORKS` | `999` | Tope (sirve para tests con N pequeño) |
| `RECONCILIATION_DRY_RUN` | `false` | Pasar `true` para simular sin escribir |

**Comportamiento esperado al arrancar:**

```
{"event":"cron.reconciliation.scheduled","schedule":"7 * * * *", ...}
```

Si se pone `RECONCILIATION_ENABLED=false`:

```
{"event":"cron.reconciliation.disabled", ...}
```

**Cada ejecución produce** (eventos `log.info`):
- `reconciliation.cycle.start` — métricas iniciales (`total_stuck`, `in_scope`, etc.)
- `reconciliation.network.scanned` — una línea por network procesada
- `reconciliation.cycle.summary` — totales finales (`matched`, `updated`, `not_found`, `errors`, `ms`)
- Persistencia en `syncstates` collection con `key="cisco_reconciliation"` para auditoría histórica.

**Despliegue:**

```bash
# 1) Desactivar el wrapper externo (no haya dos reconciliaciones a la vez)
crontab -e
# Comentar la línea: 7 * * * * /home/pbs/init/fase-a-reconciliacion/run-reconcile.sh

# 2) Rebuild del contenedor con el código nuevo
cd /home/pbs/ms-helix-mep3
docker compose up -d --build ms-helix-mep

# 3) Verificar arranque
docker logs --tail 50 ms-helix-mep | grep cron.reconciliation
# Debe aparecer: cron.reconciliation.scheduled  schedule="7 * * * *"

# 4) Esperar al minuto 7 de la siguiente hora y verificar
docker logs --since 10m ms-helix-mep | grep reconciliation
# Aparecen los eventos cycle.start / network.scanned / cycle.summary
```

**Rollback:** restaurar `index.ts` desde el backup, eliminar `reconciliation.service.ts`, rebuild, reactivar el wrapper externo en crontab. El wrapper externo y el script `reconcile-v2.js` permanecen en `/home/pbs/init/fase-a-reconciliacion/` como herramienta manual de emergencia o smoke-test.

#### B2. `sortBy=resolvedAt`   REVERTIDA (2026-05-13)

Inicialmente se desplegó pasando `sortBy: "resolvedAt"` al cliente Cisco asumiendo que el bug raíz era ordenamiento por `startedAt desc` (default presunto). Tras desplegar B3+B4, al monitorear se descubrió que **durante el tiempo que B2 estuvo activa NO llegaba ningún CESE al NMS**.

**Causa real del problema con `sortBy=resolvedAt`:**

Con `sortBy=resolvedAt sortOrder=descending`, Cisco devuelve registros con `resolvedAt:null` al inicio de la página (NULL tratado como > toda fecha en ordenamiento desc). Verificación empírica:

| Variante probada | Resolved válidos |
|---|---|
| `sortBy=resolvedAt&sortOrder=descending` | **0 de 50** (todos null) |
| `sortBy=resolvedAt&sortOrder=descending&dismissed=false` | 0 de 50 |
| sin `sortBy` (default Cisco) | **50 de 50** (todos válidos, rango reciente) |

La teoría inicial de causa raíz también era incorrecta: el default de Cisco para `resolved=true` SÍ ordena por `resolvedAt desc` excluyendo nulls. Quitar `sortBy` no reintroduce el bug original — la Fase B1 (reconciliación interna) cubre cualquier alerta que quede pegada por otras causas.

**Cambios revertidos** (2026-05-13):

| Archivo | Estado actual |
|---|---|
| `src/services/cisco.alerts.service.ts` | Conserva `sortBy?: string` opcional (no daña, queda disponible) |
| `src/services/cese.alerts.service.ts` | **Quita** `sortBy: "resolvedAt"` (vuelve al default de Cisco) |

**Filtro defensivo añadido al revertir:** dentro de `getCeseAlerts`, después de obtener la página de Cisco, se descartan registros con `resolvedAt:null` antes de procesarlos. Si Cisco cambia su comportamiento en el futuro y vuelve a colar nulls, se reportan en `log.warn` como `cese.page.dropped_null_resolvedAt` y no contaminan la base.

**Backup pre-revert:** `/home/pbs/init/host-backup-revert-b2-<timestamp>/cese.alerts.service.ts`.

**Lección aprendida:** validar empíricamente las suposiciones sobre la API de Cisco antes de codificar la lógica. La doc de Meraki dice que `sortBy` default es `startedAt`, pero en práctica el endpoint `assurance/alerts` con `resolved=true` parece comportarse distinto.

**Rollback:** restaurar los dos `.ts` del backup `host-backup-fase-b2-*` y rebuild. El cliente Cisco vuelve a no enviar `sortBy` y se restaura el comportamiento previo.

#### B3. Drift en `/health`  ✅ COMPLETADA (2026-05-12)

El endpoint `GET /health` ahora reporta un bloque `drift` con observabilidad operativa de stuck alerts y el estado del último ciclo de reconciliación.

**Forma de la respuesta** (campos nuevos en el JSON existente):

```json
{
  "drift": {
    "stuck_1h":  N,
    "stuck_6h":  N,
    "stuck_24h": N,
    "oldest_stuck": {
      "alertId":   "…",
      "startedAt": "2026-05-…",
      "age_hours": NN
    } | null,
    "last_reconciliation": {
      "at": "2026-05-12T23:07:…",
      "metadata": { matched, updated, in_scope, … }
    } | null
  }
}
```

**Qué significan los campos:**

| Campo | Definición | Comportamiento esperado en operación normal |
|---|---|---|
| `stuck_Nh` | Alertas con `resolvedAt:null`, `isGlpi:true`, `startedAt < now-Nh` | `stuck_1h` puede ser >0 normalmente (equipos genuinamente caídos); `stuck_6h` y `stuck_24h` deberían ser bajos |
| `oldest_stuck` | La alerta sin cesar más antigua, con su edad en horas | Útil para monitoreo: si `age_hours` crece sin parar, hay bug o equipo abandonado |
| `last_reconciliation` | Snapshot del último ciclo del cron B1 (lee de `syncstates`) | `metadata.matched`/`updated` casi siempre debe ser ~0 con B2 desplegado |

**Cambio:** `src/index.ts` — `Promise.all` extendido con 4 conteos adicionales y `getSyncState("cisco_reconciliation")`. Sin nuevos endpoints, sin breaking changes.

**Uso para alertar:**

```bash
# Operacional: alertar si stuck_24h supera un umbral
curl -s http://localhost:${HTTP_PORT}/health | jq '.drift.stuck_24h'

# Watchdog: alertar si el cron de reconciliación dejó de correr
curl -s http://localhost:${HTTP_PORT}/health | \
  jq -r '.drift.last_reconciliation.at // "never"'
```

#### B4. Manejo robusto del 429  ✅ COMPLETADA (2026-05-12)

Antes, ante un 429 el cliente Cisco devolvía un objeto `error` o status≠200 y el `cese.alerts.service` asumía 429 sin verificar, reintentando dentro del mismo ciclo del cron solo 5s después — insuficiente si Cisco pedía `Retry-After: 30`.

Ahora **el cliente reintenta internamente** la misma página respetando `Retry-After` (con margen de +2s), hasta `CISCO_429_MAX_RETRIES=5` (configurable). El caller ya no tiene que adivinar status codes.

**Archivos:**

| Archivo | Cambio |
|---|---|
| `src/services/cisco.alerts.service.ts` | Refactor de `getAllMerakiAlertsApi`: loop interno con backoff respetando `Retry-After`. Devuelve `AxiosResponse \| null` (null solo en error de red). Logging estructurado: `cisco.429.retry`, `cisco.429.recovered`, `cisco.429.exhausted`, `cisco.fetch.network_error`. Timeout de 30s en cada request. |
| `src/services/cese.alerts.service.ts` | `fetchAlerts` ahora maneja `null` del cliente (network error → corta ciclo, próximo cron retoma). El branch `else` se reserva para 4xx no-429 y 429 con budget exhausted. Migra `console.log/error` críticos a `log.warn/error` estructurado. |
| `src/services/CiscoMerakiAPIService.ts` | `MAX_RETRIES` de 2→5 (configurable vía `CISCO_429_MAX_RETRIES`). Migración de `console.warn` críticos a `log.warn` estructurado: `cisco_module.429.retry`, `cisco_module.429.exhausted`. |

**Backup pre-cambio:** `/home/pbs/init/host-backup-fase-b3b4-<timestamp>/{index.ts,services/{cisco,cese}.alerts.service.ts,services/CiscoMerakiAPIService.ts}`.

**Variables de entorno opcionales:**

| Variable | Default | Descripción |
|---|---|---|
| `CISCO_429_MAX_RETRIES` | `5` | Reintentos por página antes de devolver el 429 al caller |
| `CISCO_429_DEFAULT_RETRY_SEC` | `10` | Espera (s) cuando Cisco no envía header `Retry-After` |

**Eventos de log a vigilar:**

```bash
# Reintentos activos (esperados ocasionalmente bajo carga)
docker logs --since 1h ms-helix-mep | grep cisco.429.retry

# Recovery exitoso tras retries (esperado: alta tasa de recovery)
docker logs --since 1h ms-helix-mep | grep cisco.429.recovered

# Síntoma real de problema: budget agotado
docker logs --since 1h ms-helix-mep | grep cisco.429.exhausted

# Cualquier error de red de Cisco
docker logs --since 1h ms-helix-mep | grep cisco.fetch.network_error
```

**Rollback:** restaurar los 4 archivos del backup `host-backup-fase-b3b4-*` y rebuild.

#### B5. Paginación de la reconciliación  ✅ COMPLETADA (2026-05-13)

**Bug detectado:** la primera implementación de `ReconciliationService.fetchResolvedPage` solo leía **una página** (300 alertas) por network. En networks "hiperactivas" donde Cisco genera 300+ resoluciones/día (e.g. `L_3865777330144150697 - C.T.P Guácimo`), la primera página solo cubría las últimas 4–5 horas. Cualquier alerta resuelta antes de esa ventana caía en páginas 2+, jamás consultadas → `matched=0` aunque Cisco sí la tuviera resuelta.

**Evidencia:** ciclo del 2026-05-13 01:07 con código viejo: `total_stuck=478, in_scope=304, matched=2, not_found=302` — 99.3% no encontradas.

**Caso disparador:** alerta `3865777330154712655` (device `SAMEP-02APT007LI4228`) — `startedAt=2026-05-12T13:15:30Z`, `resolvedAt` en Cisco `2026-05-12T14:25:37Z`. La página 1 de su network cubría 20:28 → 01:01 del día siguiente; la alerta del 14:25 estaba en página 2.

**Fix:** `fetchResolvedPage` renombrado a `fetchResolvedAlertsForNetwork(networkId, stuckAlerts)`. Itera siguiendo `Link: rel=next` con tres condiciones de salida:

| Exit reason | Cuándo se aplica |
|---|---|
| `all_matched` | Encontró el `alertId` de todas las stuck de esa network — no tiene sentido seguir |
| `past_oldest_stuck` | La última `resolvedAt` de la página es anterior al `startedAt` más antiguo de las stuck — matemáticamente no puede haber más matches en páginas posteriores |
| `no_more_pages` | Cisco no devolvió header `Link: rel=next` |
| `max_pages_reached` | Tope de seguridad — `RECONCILIATION_MAX_PAGES_PER_NETWORK` (default 8) |

Entre páginas se aplica `sleep(rateDelayMs)` (default 11s) para respetar el rate-limit Cisco (1 req/10s sustained). El handler de 429 con `Retry-After` ya existía y se conserva.

**Logging nuevo:**
- `reconciliation.network.scanned` ahora incluye `pages` y `exit_reason`.
- `reconciliation.cycle.summary` ahora incluye `pages_total`.

**Variable de entorno nueva (opcional):**

| Variable | Default | Descripción |
|---|---|---|
| `RECONCILIATION_MAX_PAGES_PER_NETWORK` | `8` | Tope de seguridad por network. Cubre ≈2400 resoluciones — suficiente para networks con miles de eventos diarios |

**Archivos:**

| Archivo | Cambio |
|---|---|
| `src/services/reconciliation.service.ts` | Reemplazo de `fetchResolvedPage` (1 página) por `fetchResolvedAlertsForNetwork` (iterativo con corte temprano). Constructor lee `RECONCILIATION_MAX_PAGES_PER_NETWORK`. `run()` pasa el array de stuck al fetcher para que conozca las condiciones de corte |

**Backup pre-cambio:** `/home/pbs/init/host-backup-recon-paginated-20260513-014215/` contiene `reconciliation.service.ts.original` (pre-fix) y `reconciliation.service.ts.new` (post-fix).

**Validación end-to-end:** ciclo manual disparado a 01:50:18 procesó 92 networks. Verificación de la alerta disparadora a 02:35:27:
- `network.scanned`: `pages: 8, exit_reason: max_pages_reached, matched: 3/4`
- Alerta `3865777330154712655` en MEP DB: `resolvedAt: "2026-05-12T14:25:37Z", isTcp: false`
- `validateAndBuildAlertsToSend` (cada 1 min) envía el CESE al TCP en el siguiente tick
- Usuario confirmó CESE recibido en NMS Helix

**Cómo verificar empíricamente** que una network sí necesita paginar:

```bash
docker exec ms-helix-mep node -e '
const axios = require("axios");
axios.get("https://api.meraki.com/api/v1/organizations/" + process.env.ORGANIZATION_ID + "/assurance/alerts", {
  headers: { Authorization: "Bearer " + process.env.TOKEN_CISCO },
  params: { active: false, resolved: true, networkId: "NETWORK_ID",
            perPage: 300, sortOrder: "descending" }
}).then(r => {
  console.log("first:",  r.data[0]?.resolvedAt);
  console.log("last:",   r.data[r.data.length-1]?.resolvedAt);
  console.log("link header:", r.headers.link || "(none)");
});'
```

Si `last > MIN(startedAt de las stuck en esa network)` → la página 1 es insuficiente, hace falta paginar.

**Comportamiento operativo esperado:**
- Networks normales (<5 stuck, <300 resoluciones diarias): `pages: 1, exit_reason: past_oldest_stuck|no_more_pages`.
- Networks medianas con stuck del día previo: `pages: 2–4, exit_reason: all_matched|past_oldest_stuck`.
- Networks hiperactivas con muchas stuck viejas: `pages: 5–8, exit_reason: max_pages_reached` ocasional — si esto se vuelve frecuente, subir `RECONCILIATION_MAX_PAGES_PER_NETWORK` o investigar device en mal estado.

**Rollback:** restaurar `reconciliation.service.ts.original` del backup y rebuild.

---

### FASE C — Solución definitiva (mediano plazo)  📋 PROPUESTA

**Migración a Webhooks de Meraki.** Meraki Dashboard soporta push events para alertas.

- Sin rate-limits (Cisco empuja, no preguntamos).
- Sin problema de cobertura (cada evento llega individualmente).
- Latencia segundos en lugar de minutos.
- Reduce ~99% del tráfico saliente a Cisco.

Requiere:
- Endpoint público (o vía proxy) que reciba el webhook.
- Validación de firma con shared secret.
- Coordinación con red/seguridad para exponer el puerto.

---

## 5. Estado actual del trabajo

| Fase | Estado | Fecha |
|---|---|---|
| A — Reparación inmediata (<30d) | ✅ **Completada** | 2026-05-12 |
| A.2 — Alertas >30 días | ✅ **Completada** (vía CESE masivo, opción A) | 2026-05-13 |
| B1 — Cron reconciliación interno | ✅ **Completada** | 2026-05-12 |
| B2 — sortBy=resolvedAt | ⚠️ **Revertida** (rompía cesaciones) | 2026-05-13 |
| B3 — Drift en healthcheck | ✅ **Completada** | 2026-05-12 |
| B4 — 429 robusto | ✅ **Completada** | 2026-05-12 |
| B5 — Paginación de la reconciliación | ✅ **Completada** | 2026-05-13 |
| C — Webhooks Meraki | 📋 Propuesta | — |

---

## 6. Artefactos

### Carpeta `/home/pbs/init/fase-a-reconciliacion/`

| Archivo | Descripción |
|---|---|
| `reconcile-v2.js` | Script principal de Fase A — funcional y validado |
| `reconcile.js` | Versión v1 (deprecada, problemas de rate-limit) |
| `dryrun-v2-20260512-010239.log` | Log del dry-run completo previo al apply real |
| `apply-20260512-013522.log` | Log del apply real ejecutado |

### Comandos clave de operación

```bash
# Snapshot de stuck en MEP DB
docker exec mongodb-helix-mep mongosh --quiet -u andrair -p 1234 \
  --authenticationDatabase admin ms_helix_mep --eval '
const cutoffHr = new Date(Date.now() - 3600*1000).toISOString();
const cutoff30 = new Date(Date.now() - 30*24*3600*1000).toISOString();
print("stuck <30d:",
  db.alerts.countDocuments({resolvedAt:null, isGlpi:true,
                            startedAt:{$lt:cutoffHr, $gte:cutoff30}}));
print("stuck >=30d:",
  db.alerts.countDocuments({resolvedAt:null, isGlpi:true,
                            startedAt:{$lt:cutoff30}}));
'

# Verificar el flujo end-to-end (los 3 enlaces)
docker logs ms-helix-mep --since 5m  2>&1 | grep '"send.cron.summary"'
docker logs ms-helix-tcp --since 5m  2>&1 | grep '"sender.summary"'

# Probe puntual de una alerta contra Cisco (reemplazar ALERT_ID y NETWORK_ID)
docker exec ms-helix-mep node -e '
const axios = require("axios");
axios.get("https://api.meraki.com/api/v1/organizations/846353/assurance/alerts", {
  headers: { Authorization: "Bearer " + process.env.TOKEN_CISCO },
  params: { active: false, resolved: true, networkId: "NETWORK_ID",
            perPage: 300, sortOrder: "descending" }
}).then(r => {
  const a = r.data.find(x => x.id === "ALERT_ID");
  console.log(a ? JSON.stringify(a, null, 2) : "not found in page 1");
});
'
```

---

## 7. Historial de cambios

| Fecha | Cambio | Quién |
|---|---|---|
| 2026-05-12 | Documento creado tras diagnóstico inicial | — |
| 2026-05-12 | Fase A ejecutada: 20 alertas reparadas, end-to-end verificado | — |
| 2026-05-12 | Agregadas secciones 4.A.3 (ejecución manual), 4.A.4 (monitoreo), Fase A.2 (alertas >30d) | — |
| 2026-05-12 | Wrapper externo (`run-reconcile.sh`) operativo + `docker cp` self-healing tras restart del contenedor | — |
| 2026-05-12 | Fase B1 completada: `ReconciliationService` + 4° cron en `index.ts`. Reemplaza al wrapper externo y se replica con el repo | — |
| 2026-05-12 | Fase B2 completada: `sortBy=resolvedAt` en el cliente Cisco para el CESE service. Ataca la causa raíz del bug | — |
| 2026-05-12 | Fase B3 completada: bloque `drift` en `/health` con conteos stuck_{1h,6h,24h}, oldest_stuck y last_reconciliation | — |
| 2026-05-12 | Fase B4 completada: retry interno robusto del cliente Cisco respetando Retry-After (5 retries) en `cisco.alerts.service.ts` y `CiscoMerakiAPIService.ts` | — |
| 2026-05-13 | B2 revertida: con `sortBy=resolvedAt desc` Cisco devolvía nulls al frente y bloqueaba TODAS las cesaciones. Se vuelve al default de Cisco + filtro defensivo de `resolvedAt:null` | — |
| 2026-05-13 | Fase B5 completada: `ReconciliationService.fetchResolvedPage` solo leía 1 página → 99% no-found en networks hiperactivas. Reemplazado por `fetchResolvedAlertsForNetwork` con paginación iterativa, corte temprano por relevancia y tope `RECONCILIATION_MAX_PAGES_PER_NETWORK` (8). Validado end-to-end con la alerta `3865777330154712655` (device `SAMEP-02APT007LI4228`) | — |
| 2026-05-13 | Fase A.2 completada vía opción A (CESE masivo): `updateMany` sobre las 174 alertas >30d con `resolvedAt=now, isTcp=false`. El cron de send despachó 174 CESEs al TCP→NMS (`tcp_success=176, tcp_failed=0`). Drift post: `stuck_1h 462→288`, `oldest_stuck` ahora dentro de los 30d (todas las viejas resueltas). Backup en `host-backup-cese174-20260513-032144/` con los 174 IDs para rollback puntual si hiciera falta | — |

import Alert from "../models/Alert";
import { recordSync } from "../models/SyncState";
import ReconciliationRun, { IReconciliationForceLookup } from "../models/ReconciliationRun";
import { fetchMerakiPage } from "../queues/meraki.queue";
import { lookupAlerts } from "./alertLookup.service";
import { log } from "../utils/logger";

type CiscoResolvedAlert = {
  id?: string;
  resolvedAt?: string;
};

type StuckAlert = {
  alertId: string;
  startedAt: string;
  network?: { id?: string };
};

export type ReconciliationSummary = {
  totalStuck: number;
  inScope: number;
  outOfScope: number;
  networksQueried: number;
  pagesTotal: number;
  matched: number;
  updated: number;
  notFound: number;
  errors: number;
  dryRun: boolean;
  // Alertas que estaban dentro del alcance (in scope) pero que NO aparecieron
  // en el endpoint de resueltos de Meraki para su red -- o el endpoint ya no
  // tiene ese resuelto tan viejo (retención), o siguen realmente activas.
  // Usado por el script de backfill para decidir qué necesita el fallback
  // por estado de dispositivo (ver 01_FIX_ALERTAS_RETENIDAS, Fase E).
  notFoundAlerts: Array<{ alertId: string; networkId?: string; startedAt: string }>;
  // Alertas que SI hicieron match contra el histórico de resueltos de Meraki
  // (y que en modo real -- no dry-run -- quedaron con resolvedAt actualizado).
  matchedAlerts: Array<{
    alertId: string;
    networkId?: string;
    startedAt: string;
    resolvedAt: string;
  }>;
  // Segunda pasada, independiente del escaneo por red de arriba -- ver
  // forceResolveStuckAlertsByIdLookup().
  forceLookup: IReconciliationForceLookup;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ReconciliationService {
  private static isProcessing = false;

  private readonly orgId: string;
  private readonly token: string;
  private readonly maxAgeDays: number;
  private readonly rateDelayMs: number;
  private readonly stuckHours: number;
  private readonly maxNetworks: number;
  private readonly maxPagesPerNetwork: number;
  private readonly dryRun: boolean;
  private readonly source: string;
  private readonly forceLookupEnabled: boolean;
  private readonly forceLookupStuckDays: number;
  private readonly forceLookupMaxPerRun: number;

  constructor(overrides?: {
    maxAgeDays?: number;
    rateDelayMs?: number;
    stuckHours?: number;
    maxNetworks?: number;
    maxPagesPerNetwork?: number;
    dryRun?: boolean;
    // "cron" (default, corrida horaria normal) o "backfill" (script one-off
    // de Fase E) -- queda grabado en Alert.resolvedVia y en ReconciliationRun
    // para poder distinguir en Compass quién cerró cada alerta.
    source?: string;
    forceLookupEnabled?: boolean;
    forceLookupStuckDays?: number;
    forceLookupMaxPerRun?: number;
  }) {
    this.orgId = process.env.ORGANIZATION_ID || "";
    this.token = process.env.TOKEN_CISCO || "";
    this.maxAgeDays =
      overrides?.maxAgeDays ??
      parseInt(process.env.RECONCILIATION_MAX_AGE_DAYS || "30", 10);
    this.rateDelayMs =
      overrides?.rateDelayMs ??
      parseInt(process.env.RECONCILIATION_RATE_DELAY_MS || "11000", 10);
    this.stuckHours =
      overrides?.stuckHours ??
      parseInt(process.env.RECONCILIATION_STUCK_HOURS || "1", 10);
    this.maxNetworks =
      overrides?.maxNetworks ??
      parseInt(process.env.RECONCILIATION_MAX_NETWORKS || "999", 10);
    this.maxPagesPerNetwork =
      overrides?.maxPagesPerNetwork ??
      parseInt(process.env.RECONCILIATION_MAX_PAGES_PER_NETWORK || "8", 10);
    this.dryRun = overrides?.dryRun ?? process.env.RECONCILIATION_DRY_RUN === "true";
    this.source = overrides?.source ?? "cron";
    // Segunda pasada por lookup individual -- independiente del escaneo por
    // red de arriba, y SIN el límite de maxAgeDays (ese límite existe por la
    // paginación del endpoint de lista, que este camino no usa: consulta
    // cada alertId directo contra GET assurance/alerts/{id}).
    this.forceLookupEnabled =
      overrides?.forceLookupEnabled ??
      process.env.RECONCILIATION_FORCE_LOOKUP_ENABLED !== "false";
    this.forceLookupStuckDays =
      overrides?.forceLookupStuckDays ??
      parseInt(process.env.RECONCILIATION_FORCE_LOOKUP_STUCK_DAYS || "2", 10);
    this.forceLookupMaxPerRun =
      overrides?.forceLookupMaxPerRun ??
      parseInt(process.env.RECONCILIATION_FORCE_LOOKUP_MAX_PER_RUN || "100", 10);
  }

  async run(): Promise<ReconciliationSummary | undefined> {
    if (ReconciliationService.isProcessing) {
      log.info("reconciliation.skip", { reason: "already_running" });
      return undefined;
    }
    if (!this.orgId || !this.token) {
      log.error("reconciliation.config.missing", {
        orgId: Boolean(this.orgId),
        token: Boolean(this.token),
      });
      return undefined;
    }

    ReconciliationService.isProcessing = true;
    const t0 = Date.now();

    let networksQueried = 0;
    let matched = 0;
    let updated = 0;
    let notFound = 0;
    let errors = 0;
    let pagesTotal = 0;
    const notFoundAlerts: ReconciliationSummary["notFoundAlerts"] = [];
    const matchedAlerts: ReconciliationSummary["matchedAlerts"] = [];

    try {
      const stuckCutoff = new Date(Date.now() - this.stuckHours * 3600 * 1000).toISOString();
      const ageCutoff = new Date(Date.now() - this.maxAgeDays * 24 * 3600 * 1000).toISOString();

      const all = await Alert.find({
        resolvedAt: null,
        isGlpi: true,
        startedAt: { $lt: stuckCutoff },
      }).lean<StuckAlert[]>();

      const inScope = all.filter((a) => a.startedAt >= ageCutoff);
      const outOfScope = all.length - inScope.length;

      log.info("reconciliation.cycle.start", {
        total_stuck: all.length,
        in_scope: inScope.length,
        out_of_scope: outOfScope,
        max_age_days: this.maxAgeDays,
        rate_delay_ms: this.rateDelayMs,
        max_pages_per_network: this.maxPagesPerNetwork,
        dry_run: this.dryRun,
      });

      if (inScope.length === 0) {
        const forceLookup = await this.forceResolveStuckAlertsByIdLookup();
        log.info("reconciliation.cycle.empty", { ms: Date.now() - t0 });
        await recordSync("cisco_reconciliation", {
          metadata: {
            total_stuck: all.length,
            in_scope: 0,
            out_of_scope: outOfScope,
            networks_queried: 0,
            matched: 0,
            updated: 0,
            not_found: 0,
            errors: 0,
            dry_run: this.dryRun,
            force_lookup: forceLookup,
          },
        });
        await this.persistRun({
          t0,
          totalStuck: all.length,
          inScope: 0,
          outOfScope,
          networksQueried: 0,
          pagesTotal: 0,
          matched: 0,
          updated: 0,
          notFound: 0,
          errors: 0,
          matchedAlerts: [],
          notFoundAlerts: [],
          forceLookup,
        });
        return {
          totalStuck: all.length,
          inScope: 0,
          outOfScope,
          networksQueried: 0,
          pagesTotal: 0,
          matched: 0,
          updated: 0,
          notFound: 0,
          errors: 0,
          dryRun: this.dryRun,
          notFoundAlerts: [],
          matchedAlerts: [],
          forceLookup,
        };
      }

      const byNetwork = new Map<string, StuckAlert[]>();
      for (const a of inScope) {
        const nid = a.network?.id;
        if (!nid) continue;
        const bucket = byNetwork.get(nid);
        if (bucket) bucket.push(a);
        else byNetwork.set(nid, [a]);
      }

      const networks = Array.from(byNetwork.entries())
        .sort((x, y) => {
          const minX = Math.min(...x[1].map((a) => new Date(a.startedAt).getTime()));
          const minY = Math.min(...y[1].map((a) => new Date(a.startedAt).getTime()));
          return minY - minX;
        })
        .slice(0, this.maxNetworks);

      for (let i = 0; i < networks.length; i++) {
        const entry = networks[i];
        if (!entry) continue;
        const [nid, alerts] = entry;
        networksQueried++;

        let scan: { resolved: CiscoResolvedAlert[]; pages: number; exitReason: string };
        try {
          scan = await this.fetchResolvedAlertsForNetwork(nid, alerts);
        } catch (e: any) {
          log.warn("reconciliation.network.fetch.error", {
            network_id: nid,
            message: e?.message,
          });
          errors += alerts.length;
          if (i < networks.length - 1) await sleep(this.rateDelayMs);
          continue;
        }

        pagesTotal += scan.pages;

        const resolvedMap = new Map<string, string>();
        for (const r of scan.resolved) {
          if (r?.id && r?.resolvedAt) resolvedMap.set(r.id, r.resolvedAt);
        }

        let networkMatched = 0;
        for (const a of alerts) {
          const ciscoResolvedAt = resolvedMap.get(a.alertId);
          if (!ciscoResolvedAt) {
            notFound++;
            notFoundAlerts.push({
              alertId: a.alertId,
              networkId: a.network?.id,
              startedAt: a.startedAt,
            });
            continue;
          }
          matched++;
          networkMatched++;
          matchedAlerts.push({
            alertId: a.alertId,
            networkId: a.network?.id,
            startedAt: a.startedAt,
            resolvedAt: ciscoResolvedAt,
          });
          if (this.dryRun) continue;
          try {
            const r = await Alert.findOneAndUpdate(
              { alertId: a.alertId, resolvedAt: null },
              {
                $set: {
                  resolvedAt: ciscoResolvedAt,
                  isTcp: false,
                  resolvedVia: `reconciliation:${this.source}`,
                  reconciledAt: new Date(),
                },
              },
              { new: true }
            );
            if (r) updated++;
          } catch (e: any) {
            errors++;
            log.warn("reconciliation.update.error", {
              alertId: a.alertId,
              message: e?.message,
            });
          }
        }

        log.info("reconciliation.network.scanned", {
          network_id: nid,
          page_size: scan.resolved.length,
          pages: scan.pages,
          exit_reason: scan.exitReason,
          stuck_in_network: alerts.length,
          matched: networkMatched,
        });

        if (i < networks.length - 1) await sleep(this.rateDelayMs);
      }

      const forceLookup = await this.forceResolveStuckAlertsByIdLookup();

      log.info("reconciliation.cycle.summary", {
        ms: Date.now() - t0,
        total_stuck: all.length,
        in_scope: inScope.length,
        out_of_scope: outOfScope,
        networks_queried: networksQueried,
        pages_total: pagesTotal,
        matched,
        updated,
        not_found: notFound,
        errors,
        dry_run: this.dryRun,
        force_lookup: forceLookup,
      });

      await recordSync("cisco_reconciliation", {
        metadata: {
          total_stuck: all.length,
          in_scope: inScope.length,
          out_of_scope: outOfScope,
          networks_queried: networksQueried,
          pages_total: pagesTotal,
          matched,
          updated,
          not_found: notFound,
          errors,
          dry_run: this.dryRun,
          force_lookup: forceLookup,
        },
      });

      await this.persistRun({
        t0,
        totalStuck: all.length,
        inScope: inScope.length,
        outOfScope,
        networksQueried,
        pagesTotal,
        matched,
        updated,
        notFound,
        errors,
        matchedAlerts,
        notFoundAlerts,
        forceLookup,
      });

      return {
        totalStuck: all.length,
        inScope: inScope.length,
        outOfScope,
        networksQueried,
        pagesTotal,
        matched,
        updated,
        notFound,
        errors,
        dryRun: this.dryRun,
        notFoundAlerts,
        matchedAlerts,
        forceLookup,
      };
    } catch (e: any) {
      log.error("reconciliation.cycle.error", {
        ms: Date.now() - t0,
        message: e?.message,
      });
      await recordSync("cisco_reconciliation", {
        lastError: e?.message ?? "unknown",
      });
      return undefined;
    } finally {
      ReconciliationService.isProcessing = false;
    }
  }

  /**
   * Deja un documento permanente en `reconciliation_runs` por cada corrida
   * (cron o backfill, incluido dry-run) -- ver `ReconciliationRun.ts`.
   * Best-effort: un fallo acá no debe tumbar el ciclo de reconciliación en
   * sí, solo se loguea.
   */
  private async persistRun(args: {
    t0: number;
    totalStuck: number;
    inScope: number;
    outOfScope: number;
    networksQueried: number;
    pagesTotal: number;
    matched: number;
    updated: number;
    notFound: number;
    errors: number;
    matchedAlerts: ReconciliationSummary["matchedAlerts"];
    notFoundAlerts: ReconciliationSummary["notFoundAlerts"];
    forceLookup: IReconciliationForceLookup;
  }): Promise<void> {
    try {
      await ReconciliationRun.create({
        runAt: new Date(),
        source: this.source,
        dryRun: this.dryRun,
        maxAgeDays: this.maxAgeDays,
        totalStuck: args.totalStuck,
        inScope: args.inScope,
        outOfScope: args.outOfScope,
        networksQueried: args.networksQueried,
        pagesTotal: args.pagesTotal,
        matched: args.matched,
        updated: args.updated,
        notFound: args.notFound,
        errorCount: args.errors,
        durationMs: Date.now() - args.t0,
        matchedAlerts: args.matchedAlerts,
        notFoundAlerts: args.notFoundAlerts,
        forceLookup: args.forceLookup,
      });
    } catch (e: any) {
      log.warn("reconciliation.run_log.error", { message: e?.message });
    }
  }

  /**
   * Segunda pasada, independiente del escaneo paginado por red de arriba --
   * verifica una por una (GET assurance/alerts/{id}, vía alertLookup.service,
   * mismo gateway con rate-limit) las alertas atascadas hace más de
   * `forceLookupStuckDays` (default 2 días), SIN el límite de 30 días de
   * `maxAgeDays` -- ese límite existe solo por el riesgo de que la
   * paginación del endpoint de lista entierre un resuelto viejo; el lookup
   * individual no tiene ese problema, consulta el id directo.
   *
   * Si Meraki confirma que ya está cesada/descartada -> se resuelve con la
   * fecha real. Si Meraki ya no tiene el id (404, probablemente rotó o
   * Meraki purgó el historial) -> se resuelve igual, pero con la fecha de
   * AHORA (no la real, que no se puede saber) y un `resolvedVia` distinto
   * para dejarlo trazable como inferencia, no confirmación exacta. Si sigue
   * realmente activa, no se toca -- es una caída real, no un bug de
   * reconciliación.
   *
   * Acotado por `forceLookupMaxPerRun` (default 100) para no disparar
   * cientos de llamadas de golpe -- si hay más candidatas que eso, el resto
   * se procesa en las siguientes corridas (se ordena por más viejas primero).
   */
  private async forceResolveStuckAlertsByIdLookup(): Promise<IReconciliationForceLookup> {
    const empty: IReconciliationForceLookup = {
      candidates: 0,
      checked: 0,
      resolvedCesada: 0,
      resolvedNotFound: 0,
      stillActive: 0,
      errors: 0,
    };

    if (!this.forceLookupEnabled) return empty;

    const cutoff = new Date(
      Date.now() - this.forceLookupStuckDays * 24 * 3600 * 1000,
    ).toISOString();

    const candidates = await Alert.find({
      resolvedAt: null,
      isGlpi: true,
      startedAt: { $lt: cutoff },
    })
      .sort({ startedAt: 1 })
      .limit(this.forceLookupMaxPerRun)
      .lean<StuckAlert[]>();

    if (candidates.length === 0) return empty;

    log.info("reconciliation.force_lookup.start", {
      candidates: candidates.length,
      stuck_days: this.forceLookupStuckDays,
      dry_run: this.dryRun,
    });

    const results = await lookupAlerts(
      this.orgId,
      candidates.map((a) => a.alertId),
    );

    let resolvedCesada = 0;
    let resolvedNotFound = 0;
    let stillActive = 0;
    let errors = 0;

    for (const r of results) {
      if (r.estado === "ERROR") {
        errors++;
        continue;
      }
      if (r.estado === "ACTIVA") {
        stillActive++;
        continue;
      }

      // CESADA o NO_ENCONTRADA -> ya no debe seguir marcada como activa acá.
      const isCesada = r.estado === "CESADA";
      const resolvedAt = isCesada && r.resolvedAt ? r.resolvedAt : new Date().toISOString();
      const resolvedVia = isCesada
        ? `reconciliation:force_lookup:${this.source}`
        : `reconciliation:force_not_found:${this.source}`;

      if (this.dryRun) {
        if (isCesada) resolvedCesada++;
        else resolvedNotFound++;
        continue;
      }

      try {
        const updated = await Alert.findOneAndUpdate(
          { alertId: r.alertId, resolvedAt: null },
          { $set: { resolvedAt, isTcp: false, resolvedVia, reconciledAt: new Date() } },
          { new: true },
        );
        if (updated) {
          if (isCesada) resolvedCesada++;
          else resolvedNotFound++;
        }
      } catch (e: any) {
        errors++;
        log.warn("reconciliation.force_lookup.update.error", {
          alertId: r.alertId,
          message: e?.message,
        });
      }
    }

    const summary: IReconciliationForceLookup = {
      candidates: candidates.length,
      checked: results.length,
      resolvedCesada,
      resolvedNotFound,
      stillActive,
      errors,
    };

    log.info("reconciliation.force_lookup.summary", { ...summary });
    return summary;
  }

  private async fetchResolvedAlertsForNetwork(
    networkId: string,
    stuckAlerts: StuckAlert[],
  ): Promise<{ resolved: CiscoResolvedAlert[]; pages: number; exitReason: string }> {
    const baseUrl = `https://api.meraki.com/api/v1/organizations/${this.orgId}/assurance/alerts`;
    const baseParams = {
      active: false,
      resolved: true,
      networkId,
      perPage: 300,
      sortOrder: "descending",
    };

    const stuckIds = new Set(stuckAlerts.map((a) => a.alertId));
    const oldestStuckStartedAt = stuckAlerts.reduce(
      (acc, a) => (a.startedAt < acc ? a.startedAt : acc),
      stuckAlerts[0]?.startedAt ?? "",
    );

    const all: CiscoResolvedAlert[] = [];
    let pages = 0;
    let matchedSoFar = 0;
    let nextUrl: string | null = null;

    while (pages < this.maxPagesPerNetwork) {
      // Ya no llama a Meraki directamente: encola la petición en el
      // gateway compartido (`meraki.queue.ts`), el mismo que usan
      // ActiveAlertsService/CeseAlertsService. Eso es lo que evita que
      // reconciliation dispare peticiones a Meraki al mismo tiempo que
      // active/cese -- la causa raíz documentada en la sección 3 del
      // fix de alertas retenidas. El worker de ese gateway ya reintenta
      // ante 429 respetando Retry-After, así que un `status !== 200` que
      // llegue hasta acá es un 429 con budget de reintentos agotado (u
      // otro error real) -- se reporta como tal y el próximo ciclo de
      // reconciliación (o el próximo cron) retoma.
      // No se pasa Authorization acá: el worker lo arma desde
      // process.env.TOKEN_CISCO (ver nota en meraki.queue.ts) para que el
      // token no quede persistido en el payload del job en Redis.
      const result = await fetchMerakiPage({
        url: nextUrl || baseUrl,
        params: nextUrl ? undefined : baseParams,
      });

      if (!result) {
        log.warn("reconciliation.network.fetch.network_error", {
          network_id: networkId,
          page: pages + 1,
        });
        return { resolved: all, pages, exitReason: "network_error" };
      }

      if (result.status !== 200) {
        log.warn("reconciliation.unexpected_status", {
          network_id: networkId,
          page: pages + 1,
          status: result.status,
        });
        return { resolved: all, pages, exitReason: `status_${result.status}` };
      }

      const data = Array.isArray(result.data) ? result.data : [];
      pages++;
      all.push(...data);

      for (const a of data) {
        if (a?.id && stuckIds.has(a.id)) matchedSoFar++;
      }

      if (matchedSoFar >= stuckIds.size) {
        return { resolved: all, pages, exitReason: "all_matched" };
      }

      const lastResolvedAt = data[data.length - 1]?.resolvedAt;
      if (
        lastResolvedAt &&
        oldestStuckStartedAt &&
        lastResolvedAt < oldestStuckStartedAt
      ) {
        return { resolved: all, pages, exitReason: "past_oldest_stuck" };
      }

      const linkHeader = String(result.headers["link"] || "");
      const m = linkHeader.match(/<([^>]+)>;\s*rel=next/);
      if (!m) {
        return { resolved: all, pages, exitReason: "no_more_pages" };
      }
      nextUrl = m[1] ?? null;

      if (pages < this.maxPagesPerNetwork) {
        await sleep(this.rateDelayMs);
      }
    }

    return { resolved: all, pages, exitReason: "max_pages_reached" };
  }
}

export default ReconciliationService;

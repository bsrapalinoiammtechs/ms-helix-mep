import Alert from "../models/Alert";
import { recordSync } from "../models/SyncState";
import { fetchMerakiPage } from "../queues/meraki.queue";
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

  constructor() {
    this.orgId = process.env.ORGANIZATION_ID || "";
    this.token = process.env.TOKEN_CISCO || "";
    this.maxAgeDays = parseInt(process.env.RECONCILIATION_MAX_AGE_DAYS || "30", 10);
    this.rateDelayMs = parseInt(process.env.RECONCILIATION_RATE_DELAY_MS || "11000", 10);
    this.stuckHours = parseInt(process.env.RECONCILIATION_STUCK_HOURS || "1", 10);
    this.maxNetworks = parseInt(process.env.RECONCILIATION_MAX_NETWORKS || "999", 10);
    this.maxPagesPerNetwork = parseInt(
      process.env.RECONCILIATION_MAX_PAGES_PER_NETWORK || "8",
      10,
    );
    this.dryRun = process.env.RECONCILIATION_DRY_RUN === "true";
  }

  async run(): Promise<void> {
    if (ReconciliationService.isProcessing) {
      log.info("reconciliation.skip", { reason: "already_running" });
      return;
    }
    if (!this.orgId || !this.token) {
      log.error("reconciliation.config.missing", {
        orgId: Boolean(this.orgId),
        token: Boolean(this.token),
      });
      return;
    }

    ReconciliationService.isProcessing = true;
    const t0 = Date.now();

    let networksQueried = 0;
    let matched = 0;
    let updated = 0;
    let notFound = 0;
    let errors = 0;
    let pagesTotal = 0;

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
          },
        });
        return;
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
            continue;
          }
          matched++;
          networkMatched++;
          if (this.dryRun) continue;
          try {
            const r = await Alert.findOneAndUpdate(
              { alertId: a.alertId, resolvedAt: null },
              { $set: { resolvedAt: ciscoResolvedAt, isTcp: false } },
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
        },
      });
    } catch (e: any) {
      log.error("reconciliation.cycle.error", {
        ms: Date.now() - t0,
        message: e?.message,
      });
      await recordSync("cisco_reconciliation", {
        lastError: e?.message ?? "unknown",
      });
    } finally {
      ReconciliationService.isProcessing = false;
    }
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
      const result = await fetchMerakiPage({
        url: nextUrl || baseUrl,
        params: nextUrl ? undefined : baseParams,
        headers: { Authorization: `Bearer ${this.token}` },
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

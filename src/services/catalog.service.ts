import AlarmManual from "../models/AlarmManual";
import { log } from "../utils/logger";

interface CatalogRule {
  type: string;
  productType: string;
  categoryType: string;
  isActive: boolean;
  elementType: string;
  title: string;
  severityHelix: string;
}

const REFRESH_MS = 5 * 60 * 1000;

class CatalogService {
  private static catalog: Map<string, CatalogRule> = new Map();
  private static lastRefresh = 0;
  private static refreshing: Promise<void> | null = null;

  static async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const rules = await AlarmManual.find({ isActive: true }).lean<CatalogRule[]>();
        const map = new Map<string, CatalogRule>();
        for (const rule of rules) {
          map.set(this.key(rule.type, rule.productType), rule);
        }
        this.catalog = map;
        this.lastRefresh = Date.now();
        log.info("catalog.refreshed", { rules: rules.length });
      } catch (err: any) {
        log.error("catalog.refresh.error", { message: err?.message });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private static key(type: string | undefined | null, productType: string | undefined | null): string {
    return `${type ?? ""}|${productType ?? ""}`;
  }

  private static async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > REFRESH_MS) {
      await this.refresh();
    }
  }

  static async getRule(type: string, productType: string): Promise<CatalogRule | null> {
    await this.ensureFresh();
    return this.catalog.get(this.key(type, productType)) ?? null;
  }

  static async hasRule(type: string, productType: string): Promise<boolean> {
    await this.ensureFresh();
    return this.catalog.has(this.key(type, productType));
  }

  static getRuleSync(type: string, productType: string): CatalogRule | null {
    return this.catalog.get(this.key(type, productType)) ?? null;
  }

  static stats() {
    return {
      size: this.catalog.size,
      lastRefresh: this.lastRefresh ? new Date(this.lastRefresh).toISOString() : null,
      ageMs: Date.now() - this.lastRefresh,
    };
  }
}

export default CatalogService;

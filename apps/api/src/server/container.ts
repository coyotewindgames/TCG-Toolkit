/**
 * Composition root: instantiate services once and pass them to route factories.
 *
 * Third-party clients (Clover, TCGapi.dev) are no longer singletons because
 * their credentials live per-store in the encrypted config tables. Use the
 * `posFor(storeId)` / `tcgapiFor(storeId)` factories to get a fully wired
 * client — they cache on top of the same TTL as ConfigService.
 */
import { getDb, type Database } from '../db/client';
import { CloverClient } from '../integrations/pos/clover';
import { PkmnPricesClient } from '../integrations/pkmnprices/client';
import { TcgapiClient } from '../integrations/tcgapi/client';
import { BarcodeService } from './services/barcode';
import { CheckoutService } from './services/checkout';
import { ConfigService } from './services/config-service';
import { InventoryService } from './services/inventory';
import { OrdersService } from './services/orders';
import { PricingService } from './services/pricing';
import { ProductsService } from './services/products';
import { ScansService } from './services/scans';
import { TradeinsService } from './services/tradeins';

export interface Container {
  db: Database;
  products: ProductsService;
  scans: ScansService;
  inventory: InventoryService;
  orders: OrdersService;
  pricing: PricingService;
  checkout: CheckoutService;
  tradeins: TradeinsService;
  barcode: BarcodeService;
  configs: ConfigService;
  /** Build a Clover client for the given store, using its encrypted creds. */
  posFor(storeId: string): Promise<CloverClient>;
  /** Build a TCGapi client for the given store, using its encrypted creds. */
  tcgapiFor(storeId: string): Promise<TcgapiClient>;
  /** Build a PkmnPrices client for the given store, using its encrypted creds. */
  pkmnpricesFor(storeId: string): Promise<PkmnPricesClient>;
}

let cached: Container | null = null;

export function buildContainer(): Container {
  if (cached) return cached;
  const db = getDb();
  const configs = new ConfigService(db);

  const products = new ProductsService(db);
  const scans = new ScansService(db);
  const inventory = new InventoryService(db);
  const orders = new OrdersService(db, inventory, scans);
  const pricing = new PricingService(db);
  const tradeins = new TradeinsService(db, inventory);
  const barcode = new BarcodeService();

  async function posFor(storeId: string): Promise<CloverClient> {
    const creds = await configs.getPos(storeId);
    return new CloverClient({
      baseUrl: creds.baseUrl,
      accessToken: creds.accessToken,
      merchantId: creds.merchantId,
      webhookSigningSecret: creds.webhookSigningSecret,
    });
  }

  async function tcgapiFor(storeId: string): Promise<TcgapiClient> {
    const creds = await configs.getTcgapi(storeId);
    return new TcgapiClient({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
  }

  async function pkmnpricesFor(storeId: string): Promise<PkmnPricesClient> {
    const creds = await configs.getPkmnprices(storeId);
    return new PkmnPricesClient({ apiKey: creds.apiKey });
  }

  // CheckoutService receives a factory rather than a singleton client so each
  // call resolves the caller's store credentials.
  const checkout = new CheckoutService(db, orders, posFor);

  cached = {
    db,
    products,
    scans,
    inventory,
    orders,
    pricing,
    checkout,
    tradeins,
    barcode,
    configs,
    posFor,
    tcgapiFor,
    pkmnpricesFor,
  };
  return cached;
}

/** Test-only reset. */
export function _resetContainerForTests(): void {
  cached = null;
}

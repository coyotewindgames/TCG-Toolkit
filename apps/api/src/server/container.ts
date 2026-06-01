/**
 * Composition root: instantiate services once and pass them to route factories.
 * Express does not enforce DI; this module keeps wiring explicit and testable.
 */
import { getDb, type Database } from '../db/client';
import { CloverClient } from '../integrations/pos/clover';
import { TcgapiClient } from '../integrations/tcgapi/client';
import { BarcodeService } from './services/barcode';
import { CheckoutService } from './services/checkout';
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
  pos: CloverClient;
  tcgapi: TcgapiClient;
}

let cached: Container | null = null;

export function buildContainer(): Container {
  if (cached) return cached;
  const db = getDb();
  const pos = new CloverClient();
  const tcgapi = new TcgapiClient();

  const products = new ProductsService(db);
  const scans = new ScansService(db);
  const inventory = new InventoryService(db);
  const orders = new OrdersService(db, inventory, scans);
  const pricing = new PricingService(db);
  const checkout = new CheckoutService(db, orders, pos);
  const tradeins = new TradeinsService(db, inventory);
  const barcode = new BarcodeService();

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
    pos,
    tcgapi,
  };
  return cached;
}

import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { BadRequest } from '../../common/http-errors';

// ---------- CSV parser (RFC 4180-ish, dependency-free) ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      // line break (handle \r\n)
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // ignore fully-blank lines
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // flush last field/row
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// ---------- header normalization ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// All accepted header synonyms → canonical key
const HEADER_MAP: Record<string, string> = {
  // name
  name: 'name',
  cardname: 'name',
  productname: 'name',
  title: 'name',
  // set
  set: 'set',
  setname: 'set',
  expansion: 'set',
  // set code
  setcode: 'setCode',
  setid: 'setCode',
  // card number
  number: 'cardNumber',
  cardnumber: 'cardNumber',
  collectornumber: 'cardNumber',
  no: 'cardNumber',
  // rarity
  rarity: 'rarity',
  // game
  game: 'game',
  tcg: 'game',
  category: 'game',
  // variant / printing
  variant: 'printing',
  foil: 'printing',
  finish: 'printing',
  printing: 'printing',
  edition: 'printing',
  // condition
  condition: 'condition',
  cond: 'condition',
  // language
  language: 'language',
  lang: 'language',
  // qty
  quantity: 'qty',
  qty: 'qty',
  count: 'qty',
  // prices
  purchaseprice: 'costCents',
  purchasecost: 'costCents',
  buyprice: 'costCents',
  costbasis: 'costCents',
  cost: 'costCents',
  unitcost: 'costCents',
  itemcost: 'costCents',
  yourprice: 'costCents',
  pricepaid: 'costCents',
  paid: 'costCents',
  marketprice: 'marketCents',
  marketpriceusd: 'marketCents',
  marketpricecad: 'marketCents',
  marketpriceaud: 'marketCents',
  market: 'marketCents',
  tcgmarket: 'marketCents',
  tcgmarketprice: 'marketCents',
  tcgmarketpriceusd: 'marketCents',
  tcgplayermarketprice: 'marketCents',
  price: 'marketCents',
  currentvalue: 'marketCents',
  marketvalue: 'marketCents',
  marketvalueusd: 'marketCents',
};

function indexHeaders(headers: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[norm(h)];
    if (key && idx[key] === undefined) idx[key] = i;
  });
  return idx;
}


type Game = (typeof GAMES)[number];
const GAMES = [
  'mtg',
  'pokemon',
  'yugioh',
  'lorcana',
  'one_piece',
  'flesh_and_blood',
  'sealed',
  'supplies',
  'other',
] as const;

function toGame(v: string | undefined): Game {
  const n = norm(v ?? '');
  if (!n) return 'other';
  if (n.includes('magic') || n === 'mtg') return 'mtg';
  if (n.includes('pokemon') || n.includes('pokmon') || n === 'pkm') return 'pokemon';
  if (n.includes('yugioh') || n.includes('yu')) return 'yugioh';
  if (n.includes('lorcana')) return 'lorcana';
  if (n.includes('onepiece')) return 'one_piece';
  if (n.includes('fleshandblood') || n === 'fab') return 'flesh_and_blood';
  if (n.includes('sealed')) return 'sealed';
  if (n.includes('supply') || n.includes('supplies')) return 'supplies';
  return 'other';
}

type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
function toCondition(v: string | undefined, fallback: Condition): Condition {
  const n = norm(v ?? '');
  if (!n) return fallback;
  if (n.startsWith('nm') || n.includes('nearmint') || n === 'm' || n === 'mint') return 'NM';
  if (n.startsWith('lp') || n.includes('lightlyplayed') || n.includes('excellent')) return 'LP';
  if (n.startsWith('mp') || n.includes('moderatelyplayed') || n.includes('played'))
    return 'MP';
  if (n.startsWith('hp') || n.includes('heavilyplayed') || n.includes('poor')) return 'HP';
  if (n.startsWith('dmg') || n.includes('damaged')) return 'DMG';
  throw new Error(`unrecognized condition "${v}"`);
}

type Printing = 'Normal' | 'Foil' | 'Reverse' | 'Holo' | 'FirstEdition';
function toPrinting(v: string | undefined, fallback: Printing): Printing {
  const n = norm(v ?? '');
  if (!n) return fallback;
  if (n.includes('reverseholo') || n === 'rh' || n === 'reverse') return 'Reverse';
  if (n.includes('1stedition') || n.includes('firstedition')) return 'FirstEdition';
  if (n.includes('holo')) return 'Holo';
  if (n.includes('foil') && !n.includes('non')) return 'Foil';
  if (n.includes('nonfoil') || n.includes('normal') || n === 'regular') return 'Normal';
  throw new Error(`unrecognized printing "${v}"`);
}

type Language = 'EN' | 'JP' | 'DE' | 'FR' | 'IT' | 'ES' | 'PT' | 'KO' | 'CN';
function toLanguage(v: string | undefined): Language {
  const n = norm(v ?? '');
  if (!n) return 'EN';
  if (n.startsWith('en') || n === 'english') return 'EN';
  if (n.startsWith('jp') || n.startsWith('ja') || n.includes('japanese')) return 'JP';
  if (n.startsWith('de') || n.includes('german')) return 'DE';
  if (n.startsWith('fr') || n.includes('french')) return 'FR';
  if (n.startsWith('it') || n.includes('italian')) return 'IT';
  if (n.startsWith('es') || n.includes('spanish')) return 'ES';
  if (n.startsWith('pt') || n.includes('portuguese')) return 'PT';
  if (n.startsWith('ko') || n.includes('korean')) return 'KO';
  if (n.startsWith('cn') || n.startsWith('zh') || n.includes('chinese')) return 'CN';
  return 'EN';
}

function toQty(v: string | undefined): number {
  if (!v) return 1;
  const n = parseInt(v.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function toCents(v: string | undefined): number | null {
  if (!v) return null;
  const cleaned = v.replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const f = parseFloat(cleaned);
  if (!Number.isFinite(f)) return null;
  return Math.round(f * 100);
}

// ---------- service ----------

export interface ImportRequest {
  csv: string;
  locationId: string;
  defaultCondition?: Condition;
  defaultPrinting?: Printing;
  dryRun?: boolean;
}

export interface ImportResult {
  totalRows: number;
  productsCreated: number;
  skusCreated: number;
  inventoryCreated: number;
  inventoryUpdated: number;
  costsApplied: number;
  pricesSeeded: number;
  marketPricesApplied: number;
  errors: Array<{ row: number; message: string; data?: Record<string, string> }>;
  dryRun: boolean;
}

export class InventoryImportService {
  constructor(private readonly db: Database) {}

  async import(args: { storeId: string; req: ImportRequest }): Promise<ImportResult> {
    const { storeId, req } = args;
    const result: ImportResult = {
      totalRows: 0,
      productsCreated: 0,
      skusCreated: 0,
      inventoryCreated: 0,
      inventoryUpdated: 0,
      costsApplied: 0,
      pricesSeeded: 0,
      marketPricesApplied: 0,
      errors: [],
      dryRun: !!req.dryRun,
    };

    // Validate location belongs to store
    const [loc] = await this.db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.id, req.locationId),
          eq(schema.locations.storeId, storeId),
        ),
      )
      .limit(1);
    if (!loc) throw BadRequest('locationId not found in this store');

    const rows = parseCsv(req.csv);
    if (rows.length < 2) throw BadRequest('CSV must have a header row and at least one data row');

    const headers = rows[0];
    const idx = indexHeaders(headers);
    if (idx.name === undefined) {
      throw BadRequest(
        'CSV must include a Name column (accepted: Name, Card Name, Product Name, Title)',
      );
    }

    const defaultCond: Condition = req.defaultCondition ?? 'NM';
    const defaultPrint: Printing = req.defaultPrinting ?? 'Normal';

    // The whole import runs in one transaction so a parsing error mid-file
    // doesn't leave a half-imported store.
    await this.db.transaction(async (tx) => {
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const get = (k: string) => (idx[k] !== undefined ? cells[idx[k]]?.trim() : undefined);
        result.totalRows++;

        try {
          const name = get('name');
          if (!name) {
            result.errors.push({ row: r + 1, message: 'missing name' });
            continue;
          }

          const game = toGame(get('game'));
          const setName = get('set') || null;
          const setCode = get('setCode') || null;
          const cardNumber = get('cardNumber') || null;
          const rarity = get('rarity') || null;
          const condition = toCondition(get('condition'), defaultCond);
          const printing = toPrinting(get('printing'), defaultPrint);
          const language = toLanguage(get('language'));
          const qty = toQty(get('qty'));
          const costCents = toCents(get('costCents'));
          const marketCents = toCents(get('marketCents'));

          // ---- find or create product ----
          // Match on (storeId, game, name, setName, cardNumber). NULLs treated as equal.
          const existingProducts = await tx
            .select({ id: schema.products.id })
            .from(schema.products)
            .where(
              and(
                eq(schema.products.storeId, storeId),
                eq(schema.products.name, name),
                eq(schema.products.game, game),
                setName
                  ? eq(schema.products.setName, setName)
                  : sql`${schema.products.setName} is null`,
                cardNumber
                  ? eq(schema.products.cardNumber, cardNumber)
                  : sql`${schema.products.cardNumber} is null`,
              ),
            )
            .limit(1);

          let productId: string;
          if (existingProducts[0]) {
            productId = existingProducts[0].id;
          } else {
            const [p] = await tx
              .insert(schema.products)
              .values({
                storeId,
                game,
                name,
                setName,
                setId: setCode,
                cardNumber,
                rarity,
              })
              .returning({ id: schema.products.id });
            productId = p.id;
            result.productsCreated++;
          }

          // ---- find or create sku ----
          const existingSkus = await tx
            .select({ id: schema.skus.id })
            .from(schema.skus)
            .where(
              and(
                eq(schema.skus.productId, productId),
                eq(schema.skus.condition, condition),
                eq(schema.skus.printing, printing),
                eq(schema.skus.language, language),
              ),
            )
            .limit(1);

          let skuId: string;
          if (existingSkus[0]) {
            skuId = existingSkus[0].id;
          } else {
            // sku.barcode == sku.id; insert with a placeholder, then UPDATE to match.
            const [s] = await tx
              .insert(schema.skus)
              .values({
                storeId,
                productId,
                condition,
                printing,
                language,
                barcode: 'pending',
                internalSku: 'pending',
              })
              .returning({ id: schema.skus.id });
            skuId = s.id;
            await tx
              .update(schema.skus)
              .set({ barcode: skuId, internalSku: skuId })
              .where(eq(schema.skus.id, skuId));
            result.skusCreated++;
          }

          // ---- inventory upsert (additive on qty) ----
          const existingInv = await tx
            .select({ qty: schema.inventory.qtyOnHand })
            .from(schema.inventory)
            .where(
              and(
                eq(schema.inventory.skuId, skuId),
                eq(schema.inventory.locationId, req.locationId),
              ),
            )
            .limit(1);

          if (existingInv[0]) {
            await tx
              .update(schema.inventory)
              .set({
                qtyOnHand: sql`${schema.inventory.qtyOnHand} + ${qty}`,
                ...(costCents != null
                  ? {
                      costAvgCents: sql`case
                        when ${schema.inventory.qtyOnHand} + ${qty} = 0 then 0
                        else round(
                          (${schema.inventory.costAvgCents} * ${schema.inventory.qtyOnHand} + ${costCents} * ${qty})
                          / (${schema.inventory.qtyOnHand} + ${qty})
                        )::int
                      end`,
                    }
                  : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.inventory.skuId, skuId),
                  eq(schema.inventory.locationId, req.locationId),
                ),
              );
            result.inventoryUpdated++;
          } else {
            await tx.insert(schema.inventory).values({
              skuId,
              locationId: req.locationId,
              qtyOnHand: qty,
              qtyReserved: 0,
              costAvgCents: costCents ?? 0,
            });
            result.inventoryCreated++;
          }

          if (costCents != null) {
            result.costsApplied++;
          }

          // ---- write current_prices from the import when present ----
          if (marketCents != null) {
            const existingPrice = await tx
              .select({ skuId: schema.currentPrices.skuId })
              .from(schema.currentPrices)
              .where(eq(schema.currentPrices.skuId, skuId))
              .limit(1);
            if (!existingPrice[0]) {
              await tx.insert(schema.currentPrices).values({
                skuId,
                sellPriceCents: marketCents,
                buyPriceCents: Math.round(marketCents * 0.5),
                marketPriceCents: marketCents,
              });
              result.pricesSeeded++;
            } else {
              await tx
                .update(schema.currentPrices)
                .set({
                  sellPriceCents: marketCents,
                  buyPriceCents: Math.round(marketCents * 0.5),
                  marketPriceCents: marketCents,
                })
                .where(eq(schema.currentPrices.skuId, skuId));
            }
            result.marketPricesApplied++;
          }
        } catch (err) {
          result.errors.push({
            row: r + 1,
            message: err instanceof Error ? err.message : String(err),
            data: Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])),
          });
        }
      }

      if (req.dryRun) {
        // Roll the whole transaction back so the caller can preview without
        // committing. Drizzle exposes this via tx.rollback().
        throw new RollbackForDryRun();
      }
    }).catch((err) => {
      if (err instanceof RollbackForDryRun) return;
      throw err;
    });

    return result;
  }
}

class RollbackForDryRun extends Error {
  constructor() {
    super('dry-run rollback');
  }
}

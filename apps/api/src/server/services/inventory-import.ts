import { and, eq, sql } from 'drizzle-orm';
import csvToJson from 'csvtojson';
import { schema, type Database } from '../../db/client';
import { BadRequest } from '../../common/http-errors';

type ParsedCsvRow = Record<string, string>;

// ---------- CSV parser ----------

export async function parseCsv(text: string): Promise<ParsedCsvRow[]> {
  const hasBOM = text.charCodeAt(0) === 0xfeff;
  const csvText = hasBOM ? text.slice(1) : text;

  console.info('[csv-parser] Starting CSV parse', {
    textLength: csvText.length,
    hasBOM,
  });

  const rows = await csvToJson({
    trim: false,
    checkType: false,
    ignoreEmpty: true,
  }).fromString(csvText);

  const parsedRows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')]),
    ),
  );

  console.info('[csv-parser] CSV parse complete', {
    totalRows: parsedRows.length,
    headers: Object.keys(parsedRows[0] ?? {}),
    sampleDataRow: parsedRows[0],
  });

  return parsedRows;
}

// ---------- header normalization ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const IMPORT_BATCH_SIZE = 250;

// All accepted header synonyms -> canonical key
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
  variance: 'printing',
  foil: 'printing',
  finish: 'printing',
  printing: 'printing',
  edition: 'printing',
  // condition
  condition: 'condition',
  cond: 'condition',
  cardcondition: 'condition',
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
  averagecostpaid: 'costCents',
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
    const normalizedHeader = norm(h);
    const key =
      HEADER_MAP[normalizedHeader] ??
      (normalizedHeader.startsWith('marketpriceasof') ? 'marketCents' : undefined);
    if (key && idx[key] === undefined) idx[key] = i;
  });
  return idx;
}

function normalizeParsedRow(row: ParsedCsvRow): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [header, value] of Object.entries(row)) {
    const key = indexHeaders([header]);
    const canonicalKey = Object.keys(key)[0];
    if (canonicalKey && normalized[canonicalKey] === undefined) {
      normalized[canonicalKey] = value;
    }
  }
  return normalized;
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
  if (n.startsWith('mp') || n.includes('moderatelyplayed') || n.includes('played')) return 'MP';
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

function mapRowData(row: ParsedCsvRow): Record<string, string> {
  return row;
}

function productIdentityKey(args: {
  storeId: string;
  game: Game;
  name: string;
  setName: string | null;
  cardNumber: string | null;
}): string {
  return [args.storeId, args.game, args.name, args.setName ?? '', args.cardNumber ?? ''].join('|');
}

function skuIdentityKey(args: {
  productId: string;
  condition: Condition;
  printing: Printing;
  language: Language;
}): string {
  return [args.productId, args.condition, args.printing, args.language].join('|');
}

function inventoryIdentityKey(args: { skuId: string; locationId: string }): string {
  return `${args.skuId}|${args.locationId}`;
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
    const startedAtMs = Date.now();

    console.info('[inventory-import] Starting import', {
      storeId,
      locationId: req.locationId,
      csvLength: req.csv.length,
      dryRun: !!req.dryRun,
      defaultCondition: req.defaultCondition,
      defaultPrinting: req.defaultPrinting,
    });

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
      .where(and(eq(schema.locations.id, req.locationId), eq(schema.locations.storeId, storeId)))
      .limit(1);
    if (!loc) {
      console.error('[inventory-import] Location validation failed', {
        storeId,
        locationId: req.locationId,
      });
      throw BadRequest('locationId not found in this store');
    }

    console.info('[inventory-import] Location validated', {
      storeId,
      locationId: req.locationId,
    });

    const rows = await parseCsv(req.csv);
    if (rows.length < 1) {
      console.error('[inventory-import] CSV validation failed - insufficient rows', {
        storeId,
        rowCount: rows.length,
      });
      throw BadRequest('CSV must have a header row and at least one data row');
    }

    const headers = Object.keys(rows[0] ?? {});
    const idx = indexHeaders(headers);

    console.info('[inventory-import] Headers indexed', {
      storeId,
      headers,
      indexedKeys: Object.keys(idx),
    });

    if (idx.name === undefined) {
      console.error('[inventory-import] CSV validation failed - missing Name column', {
        storeId,
        headers,
      });
      throw BadRequest('CSV must include a Name column (accepted: Name, Card Name, Product Name, Title)');
    }

    const defaultCond: Condition = req.defaultCondition ?? 'NM';
    const defaultPrint: Printing = req.defaultPrinting ?? 'Normal';

    const productCache = new Map<string, string>();
    const skuCache = new Map<string, string>();
    const inventoryPresenceCache = new Set<string>();
    const currentPricePresenceCache = new Set<string>();

    type TxLike = Pick<Database, 'select' | 'insert' | 'update'>;

    const processRow = async (tx: TxLike, r: number, rawRow: ParsedCsvRow) => {
      const row = normalizeParsedRow(rawRow);
      const get = (k: string) => row[k]?.trim();
      result.totalRows++;

      try {
        const name = get('name');
        if (!name) {
          result.errors.push({ row: r + 2, message: 'missing name', data: mapRowData(rawRow) });
          return;
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

        const productKey = productIdentityKey({ storeId, game, name, setName, cardNumber });
        let productId = productCache.get(productKey);

        if (!productId) {
          const existingProducts = await tx
            .select({ id: schema.products.id })
            .from(schema.products)
            .where(
              and(
                eq(schema.products.storeId, storeId),
                eq(schema.products.name, name),
                eq(schema.products.game, game),
                sql`coalesce(${schema.products.setName}, '') = ${setName ?? ''}`,
                sql`coalesce(${schema.products.cardNumber}, '') = ${cardNumber ?? ''}`,
              ),
            )
            .limit(1);

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
            console.info('[inventory-import] Product created', {
              productId,
              name,
              game,
              setName,
              cardNumber,
            });
          }

          productCache.set(productKey, productId);
        }

        const skuKey = skuIdentityKey({ productId, condition, printing, language });
        let skuId = skuCache.get(skuKey);

        if (!skuId) {
          const insertedSku = await tx
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
            .onConflictDoNothing()
            .returning({ id: schema.skus.id });

          if (insertedSku[0]) {
            skuId = insertedSku[0].id;
            await tx
              .update(schema.skus)
              .set({ barcode: skuId, internalSku: skuId })
              .where(eq(schema.skus.id, skuId));
            result.skusCreated++;
            console.info('[inventory-import] SKU created', {
              skuId,
              productId,
              condition,
              printing,
              language,
            });
          } else {
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

            if (!existingSkus[0]) {
              throw new Error('could not resolve SKU identity after conflict');
            }

            skuId = existingSkus[0].id;
          }

          skuCache.set(skuKey, skuId);
        }

        const invKey = inventoryIdentityKey({ skuId, locationId: req.locationId });
        let inventoryExisted = inventoryPresenceCache.has(invKey);

        if (!inventoryExisted) {
          const existingInv = await tx
            .select({ skuId: schema.inventory.skuId })
            .from(schema.inventory)
            .where(and(eq(schema.inventory.skuId, skuId), eq(schema.inventory.locationId, req.locationId)))
            .limit(1);

          inventoryExisted = !!existingInv[0];
          if (inventoryExisted) {
            inventoryPresenceCache.add(invKey);
          }
        }

        await tx
          .insert(schema.inventory)
          .values({
            skuId,
            locationId: req.locationId,
            qtyOnHand: qty,
            qtyReserved: 0,
            costAvgCents: costCents ?? 0,
          })
          .onConflictDoUpdate({
            target: [schema.inventory.skuId, schema.inventory.locationId],
            set: {
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
            },
          });

        if (inventoryExisted) {
          result.inventoryUpdated++;
        } else {
          result.inventoryCreated++;
          inventoryPresenceCache.add(invKey);
          console.info('[inventory-import] Inventory row created', {
            skuId,
            locationId: req.locationId,
            qty,
          });
        }

        if (costCents != null) {
          result.costsApplied++;
        }

        if (marketCents != null) {
          if (!currentPricePresenceCache.has(skuId)) {
            const existingPrice = await tx
              .select({ skuId: schema.currentPrices.skuId })
              .from(schema.currentPrices)
              .where(eq(schema.currentPrices.skuId, skuId))
              .limit(1);

            if (!existingPrice[0]) {
              result.pricesSeeded++;
            }

            currentPricePresenceCache.add(skuId);
          }

          await tx
            .insert(schema.currentPrices)
            .values({
              skuId,
              sellPriceCents: marketCents,
              buyPriceCents: Math.round(marketCents * 0.5),
              marketPriceCents: marketCents,
            })
            .onConflictDoUpdate({
              target: schema.currentPrices.skuId,
              set: {
                sellPriceCents: marketCents,
                buyPriceCents: Math.round(marketCents * 0.5),
                marketPriceCents: marketCents,
                updatedAt: new Date(),
              },
            });

          result.marketPricesApplied++;
        }
      } catch (err) {
        console.error('[inventory-import] Row processing error', {
          row: r + 2,
          error: err instanceof Error ? err.message : String(err),
          data: mapRowData(rawRow),
        });
        result.errors.push({
          row: r + 2,
          message: err instanceof Error ? err.message : String(err),
          data: mapRowData(rawRow),
        });
      }
    };

    if (req.dryRun) {
      await this.db
        .transaction(async (tx) => {
          for (let r = 0; r < rows.length; r++) {
            await processRow(tx, r, rows[r]);
          }

          // Roll the transaction back so dry runs are read-only while still
          // exercising the same write path and counters.
          throw new RollbackForDryRun();
        })
        .catch((err) => {
          if (err instanceof RollbackForDryRun) return;
          throw err;
        });
    } else {
      for (let batchStart = 0; batchStart < rows.length; batchStart += IMPORT_BATCH_SIZE) {
        const batchEndExclusive = Math.min(rows.length, batchStart + IMPORT_BATCH_SIZE);
        const batchStartedAtMs = Date.now();

        await this.db.transaction(async (tx) => {
          for (let r = batchStart; r < batchEndExclusive; r++) {
            await processRow(tx, r, rows[r]);
          }
        });

        console.info('[inventory-import] batch committed', {
          storeId,
          locationId: req.locationId,
          startRow: batchStart + 2,
          endRow: batchEndExclusive + 1,
          rowsProcessed: batchEndExclusive - batchStart,
          elapsedMs: Date.now() - batchStartedAtMs,
        });
      }
    }

    console.info('[inventory-import] finished', {
      storeId,
      locationId: req.locationId,
      dryRun: !!req.dryRun,
      rows: result.totalRows,
      productsCreated: result.productsCreated,
      skusCreated: result.skusCreated,
      inventoryCreated: result.inventoryCreated,
      inventoryUpdated: result.inventoryUpdated,
      errors: result.errors.length,
      elapsedMs: Date.now() - startedAtMs,
    });

    return result;
  }
}

class RollbackForDryRun extends Error {
  constructor() {
    super('dry-run rollback');
  }
}
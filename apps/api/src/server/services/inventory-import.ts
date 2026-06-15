import { randomUUID } from 'crypto';
import { and, eq, or, sql } from 'drizzle-orm';
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
const IMPORT_BATCH_SIZE = 1000;

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
  // Some exports (for example Variance=Unlimited) mean a regular non-foil print.
  if (n.includes('unlimited')) return 'Normal';
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

/**
 * Recursively inspect an error object to extract database error details.
 * Handles Drizzle ORM error wrapping and PostgreSQL driver errors.
 */
function inspectDatabaseError(err: unknown): {
  postgresCode?: string;
  postgresDetail?: string;
  postgresHint?: string;
  postgresConstraint?: string;
  postgresTable?: string;
  postgresColumn?: string;
  postgresSchema?: string;
  driverError?: unknown;
  stack?: string;
  rawError?: string;
} {
  const result: ReturnType<typeof inspectDatabaseError> = {};

  if (!err) return result;

  try {
    // Serialize the entire error for debugging
    result.rawError = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
  } catch {
    result.rawError = String(err);
  }

  if (err instanceof Error) {
    result.stack = err.stack;

    // Check for direct PostgreSQL error properties
    const anyErr = err as any;
    result.postgresCode = anyErr.code;
    result.postgresDetail = anyErr.detail;
    result.postgresHint = anyErr.hint;
    result.postgresConstraint = anyErr.constraint;
    result.postgresTable = anyErr.table;
    result.postgresColumn = anyErr.column;
    result.postgresSchema = anyErr.schema;

    // Check for nested error in 'cause' property (common in Drizzle)
    if (anyErr.cause) {
      const causeInspection = inspectDatabaseError(anyErr.cause);
      result.postgresCode = result.postgresCode ?? causeInspection.postgresCode;
      result.postgresDetail = result.postgresDetail ?? causeInspection.postgresDetail;
      result.postgresHint = result.postgresHint ?? causeInspection.postgresHint;
      result.postgresConstraint = result.postgresConstraint ?? causeInspection.postgresConstraint;
      result.postgresTable = result.postgresTable ?? causeInspection.postgresTable;
      result.postgresColumn = result.postgresColumn ?? causeInspection.postgresColumn;
      result.postgresSchema = result.postgresSchema ?? causeInspection.postgresSchema;
      result.driverError = anyErr.cause;
    }

    // Check for driver error property (node-postgres)
    if (anyErr.driverError) {
      const driverInspection = inspectDatabaseError(anyErr.driverError);
      result.postgresCode = result.postgresCode ?? driverInspection.postgresCode;
      result.postgresDetail = result.postgresDetail ?? driverInspection.postgresDetail;
      result.postgresHint = result.postgresHint ?? driverInspection.postgresHint;
      result.postgresConstraint = result.postgresConstraint ?? driverInspection.postgresConstraint;
      result.postgresTable = result.postgresTable ?? driverInspection.postgresTable;
      result.postgresColumn = result.postgresColumn ?? driverInspection.postgresColumn;
      result.postgresSchema = result.postgresSchema ?? driverInspection.postgresSchema;
      result.driverError = anyErr.driverError;
    }
  }

  return result;
}

function formatImportError(err: unknown): {
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
  hint?: string;
  schema?: string;
  stack?: string;
} {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }

  const dbErr = err as Error & {
    code?: string;
    detail?: string;
    constraint?: string;
    table?: string;
    column?: string;
    hint?: string;
    schema?: string;
    cause?: {
      code?: string;
      detail?: string;
      constraint?: string;
      table?: string;
      column?: string;
      hint?: string;
      schema?: string;
      message?: string;
    };
  };

  // Use inspectDatabaseError for comprehensive error extraction
  const inspection = inspectDatabaseError(err);

  return {
    message: dbErr.message,
    code: dbErr.code ?? dbErr.cause?.code ?? inspection.postgresCode,
    detail: dbErr.detail ?? dbErr.cause?.detail ?? inspection.postgresDetail,
    constraint: dbErr.constraint ?? dbErr.cause?.constraint ?? inspection.postgresConstraint,
    table: dbErr.table ?? dbErr.cause?.table ?? inspection.postgresTable,
    column: dbErr.column ?? dbErr.cause?.column ?? inspection.postgresColumn,
    hint: dbErr.hint ?? dbErr.cause?.hint ?? inspection.postgresHint,
    schema: dbErr.schema ?? dbErr.cause?.schema ?? inspection.postgresSchema,
    stack: inspection.stack,
  };
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

    // Pre-warm caches with bulk queries so the per-row loop hits memory
    // instead of issuing individual SELECTs for existing records.
    const [warmProducts, warmSkus, warmInv, warmPrices] = await Promise.all([
      this.db
        .select({
          id: schema.products.id,
          game: schema.products.game,
          name: schema.products.name,
          setName: schema.products.setName,
          cardNumber: schema.products.cardNumber,
        })
        .from(schema.products)
        .where(eq(schema.products.storeId, storeId)),
      this.db
        .select({
          id: schema.skus.id,
          productId: schema.skus.productId,
          condition: schema.skus.condition,
          printing: schema.skus.printing,
          language: schema.skus.language,
        })
        .from(schema.skus)
        .where(eq(schema.skus.storeId, storeId)),
      this.db
        .select({ skuId: schema.inventory.skuId })
        .from(schema.inventory)
        .where(eq(schema.inventory.locationId, req.locationId)),
      this.db
        .select({ skuId: schema.currentPrices.skuId })
        .from(schema.currentPrices)
        .innerJoin(schema.skus, eq(schema.currentPrices.skuId, schema.skus.id))
        .where(eq(schema.skus.storeId, storeId)),
    ]);

    for (const p of warmProducts) {
      productCache.set(productIdentityKey({ storeId, game: p.game, name: p.name, setName: p.setName, cardNumber: p.cardNumber }), p.id);
    }
    for (const s of warmSkus) {
      skuCache.set(skuIdentityKey({ productId: s.productId, condition: s.condition, printing: s.printing, language: s.language }), s.id);
    }
    for (const inv of warmInv) {
      inventoryPresenceCache.add(inventoryIdentityKey({ skuId: inv.skuId, locationId: req.locationId }));
    }
    for (const cp of warmPrices) {
      currentPricePresenceCache.add(cp.skuId);
    }

    console.info('[inventory-import] Caches pre-warmed', {
      storeId,
      products: productCache.size,
      skus: skuCache.size,
      inventoryRows: inventoryPresenceCache.size,
      currentPrices: currentPricePresenceCache.size,
    });

    type TxLike = Pick<Database, 'select' | 'insert'>;

    type NormalizedImportRow = {
      rowIndex: number;
      rawRow: ParsedCsvRow;
      game: Game;
      name: string;
      setName: string | null;
      setCode: string | null;
      cardNumber: string | null;
      rarity: string | null;
      condition: Condition;
      printing: Printing;
      language: Language;
      qty: number;
      costCents: number | null;
      marketCents: number | null;
      productKey: string;
    };

    type ProductCandidate = {
      productKey: string;
      game: Game;
      name: string;
      setName: string | null;
      setCode: string | null;
      cardNumber: string | null;
      rarity: string | null;
    };

    type SkuCandidate = {
      skuKey: string;
      id: string;
      productId: string;
      condition: Condition;
      printing: Printing;
      language: Language;
    };

    type InventoryWithCostPayload = {
      skuId: string;
      locationId: string;
      qty: number;
      weightedCostCents: number;
    };

    type InventoryWithoutCostPayload = {
      skuId: string;
      locationId: string;
      qty: number;
    };

    type CurrentPricePayload = {
      skuId: string;
      marketCents: number;
    };

    const normalizeRowForImport = (r: number, rawRow: ParsedCsvRow): NormalizedImportRow => {
      const row = normalizeParsedRow(rawRow);
      const get = (k: string) => row[k]?.trim();

      const name = get('name');
      if (!name) {
        throw new Error('missing name');
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

      return {
        rowIndex: r,
        rawRow,
        game,
        name,
        setName,
        setCode,
        cardNumber,
        rarity,
        condition,
        printing,
        language,
        qty,
        costCents,
        marketCents,
        productKey: productIdentityKey({ storeId, game, name, setName, cardNumber }),
      };
    };

    const bulkInsertProducts = async (tx: TxLike, candidates: ProductCandidate[]): Promise<void> => {
      if (!candidates.length) return;

      const insertedProducts = await tx
        .insert(schema.products)
        .values(
          candidates.map((candidate) => ({
            storeId,
            game: candidate.game,
            name: candidate.name,
            setName: candidate.setName,
            setId: candidate.setCode,
            cardNumber: candidate.cardNumber,
            rarity: candidate.rarity,
          })),
        )
        .onConflictDoNothing()
        .returning({
          id: schema.products.id,
          game: schema.products.game,
          name: schema.products.name,
          setName: schema.products.setName,
          cardNumber: schema.products.cardNumber,
        });

      for (const product of insertedProducts) {
        const productKey = productIdentityKey({
          storeId,
          game: product.game,
          name: product.name,
          setName: product.setName,
          cardNumber: product.cardNumber,
        });
        if (!productCache.has(productKey)) {
          productCache.set(productKey, product.id);
          result.productsCreated++;
        }
      }

      const unresolvedCandidates = candidates.filter((candidate) => !productCache.has(candidate.productKey));
      if (!unresolvedCandidates.length) return;

      const predicates = unresolvedCandidates.map((candidate) =>
        and(
          eq(schema.products.storeId, storeId),
          eq(schema.products.game, candidate.game),
          eq(schema.products.name, candidate.name),
          sql`coalesce(${schema.products.setName}, '') = ${candidate.setName ?? ''}`,
          sql`coalesce(${schema.products.cardNumber}, '') = ${candidate.cardNumber ?? ''}`,
        ),
      );

      const resolvedProducts = await tx
        .select({
          id: schema.products.id,
          game: schema.products.game,
          name: schema.products.name,
          setName: schema.products.setName,
          cardNumber: schema.products.cardNumber,
        })
        .from(schema.products)
        .where(predicates.length === 1 ? predicates[0] : or(...predicates));

      for (const product of resolvedProducts) {
        const productKey = productIdentityKey({
          storeId,
          game: product.game,
          name: product.name,
          setName: product.setName,
          cardNumber: product.cardNumber,
        });
        if (!productCache.has(productKey)) {
          productCache.set(productKey, product.id);
        }
      }

      const remaining = unresolvedCandidates.filter((candidate) => !productCache.has(candidate.productKey));
      if (remaining.length) {
        throw new Error('could not resolve product identity after bulk insert');
      }
    };

    const bulkInsertSkus = async (tx: TxLike, candidates: SkuCandidate[]): Promise<void> => {
      if (!candidates.length) return;

      const insertedSkus = await tx
        .insert(schema.skus)
        .values(
          candidates.map((candidate) => ({
            id: candidate.id,
            storeId,
            productId: candidate.productId,
            condition: candidate.condition,
            printing: candidate.printing,
            language: candidate.language,
            barcode: candidate.id,
            internalSku: candidate.id,
          })),
        )
        .onConflictDoNothing()
        .returning({
          id: schema.skus.id,
          productId: schema.skus.productId,
          condition: schema.skus.condition,
          printing: schema.skus.printing,
          language: schema.skus.language,
        });

      for (const sku of insertedSkus) {
        const skuKey = skuIdentityKey({
          productId: sku.productId,
          condition: sku.condition,
          printing: sku.printing,
          language: sku.language,
        });
        if (!skuCache.has(skuKey)) {
          skuCache.set(skuKey, sku.id);
          result.skusCreated++;
        }
      }

      const unresolvedCandidates = candidates.filter((candidate) => !skuCache.has(candidate.skuKey));
      if (!unresolvedCandidates.length) return;

      const predicates = unresolvedCandidates.map((candidate) =>
        and(
          eq(schema.skus.productId, candidate.productId),
          eq(schema.skus.condition, candidate.condition),
          eq(schema.skus.printing, candidate.printing),
          eq(schema.skus.language, candidate.language),
        ),
      );

      const resolvedSkus = await tx
        .select({
          id: schema.skus.id,
          productId: schema.skus.productId,
          condition: schema.skus.condition,
          printing: schema.skus.printing,
          language: schema.skus.language,
        })
        .from(schema.skus)
        .where(predicates.length === 1 ? predicates[0] : or(...predicates));

      for (const sku of resolvedSkus) {
        const skuKey = skuIdentityKey({
          productId: sku.productId,
          condition: sku.condition,
          printing: sku.printing,
          language: sku.language,
        });
        if (!skuCache.has(skuKey)) {
          skuCache.set(skuKey, sku.id);
        }
      }

      const remaining = unresolvedCandidates.filter((candidate) => !skuCache.has(candidate.skuKey));
      if (remaining.length) {
        throw new Error('could not resolve SKU identity after bulk insert');
      }
    };

    const bulkUpsertInventoryWithCost = async (tx: TxLike, rowsWithCost: InventoryWithCostPayload[]): Promise<void> => {
      if (!rowsWithCost.length) return;

      await tx
        .insert(schema.inventory)
        .values(
          rowsWithCost.map((row) => ({
            skuId: row.skuId,
            locationId: row.locationId,
            qtyOnHand: row.qty,
            qtyReserved: 0,
            costAvgCents: row.weightedCostCents,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.inventory.skuId, schema.inventory.locationId],
          set: {
            qtyOnHand: sql`${schema.inventory.qtyOnHand} + excluded.qty_on_hand`,
            costAvgCents: sql`case
              when ${schema.inventory.qtyOnHand} + excluded.qty_on_hand = 0 then 0::int
              else round(
                (${schema.inventory.costAvgCents} * ${schema.inventory.qtyOnHand} + excluded.cost_avg_cents * excluded.qty_on_hand)
                / (${schema.inventory.qtyOnHand} + excluded.qty_on_hand)
              )::int
            end`,
            updatedAt: new Date(),
          },
        });
    };

    const bulkUpsertInventoryWithoutCost = async (tx: TxLike, rowsWithoutCost: InventoryWithoutCostPayload[]): Promise<void> => {
      if (!rowsWithoutCost.length) return;

      await tx
        .insert(schema.inventory)
        .values(
          rowsWithoutCost.map((row) => ({
            skuId: row.skuId,
            locationId: row.locationId,
            qtyOnHand: row.qty,
            qtyReserved: 0,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.inventory.skuId, schema.inventory.locationId],
          set: {
            qtyOnHand: sql`${schema.inventory.qtyOnHand} + excluded.qty_on_hand`,
            updatedAt: new Date(),
          },
        });
    };

    const bulkUpsertCurrentPrices = async (tx: TxLike, priceRows: CurrentPricePayload[]): Promise<void> => {
      if (!priceRows.length) return;

      await tx
        .insert(schema.currentPrices)
        .values(
          priceRows.map((priceRow) => ({
            skuId: priceRow.skuId,
            sellPriceCents: priceRow.marketCents,
            buyPriceCents: Math.round(priceRow.marketCents * 0.5),
            marketPriceCents: priceRow.marketCents,
          })),
        )
        .onConflictDoUpdate({
          target: schema.currentPrices.skuId,
          set: {
            sellPriceCents: sql`excluded.sell_price_cents`,
            buyPriceCents: sql`excluded.buy_price_cents`,
            marketPriceCents: sql`excluded.market_price_cents`,
            updatedAt: new Date(),
          },
        });
    };

    const handleRowError = (r: number, rawRow: ParsedCsvRow, err: unknown, context?: { skuId?: string; locationId?: string; productId?: string }) => {
      const formattedError = formatImportError(err);
      const inspection = inspectDatabaseError(err);
      
      // Comprehensive error logging with all available context
      console.error('[inventory-import] Row processing error - FULL DETAILS', {
        row: r + 2,
        storeId,
        locationId: req.locationId,
        timestamp: new Date().toISOString(),
        
        // Error details
        errorMessage: formattedError.message,
        errorCode: formattedError.code,
        errorDetail: formattedError.detail,
        errorHint: formattedError.hint,
        errorConstraint: formattedError.constraint,
        errorTable: formattedError.table,
        errorColumn: formattedError.column,
        errorSchema: formattedError.schema,
        
        // PostgreSQL-specific details
        postgresCode: inspection.postgresCode,
        postgresDetail: inspection.postgresDetail,
        postgresHint: inspection.postgresHint,
        postgresConstraint: inspection.postgresConstraint,
        postgresTable: inspection.postgresTable,
        postgresColumn: inspection.postgresColumn,
        
        // Context
        context,
        rawRowData: rawRow,
        mappedRowData: mapRowData(rawRow),
        
        // Cache state for debugging
        cacheState: {
          productsInCache: productCache.size,
          skusInCache: skuCache.size,
          inventoryInCache: inventoryPresenceCache.size,
        },
      });
      
      // Also log the error stack for debugging
      if (formattedError.stack) {
        console.error('[inventory-import] Error stack trace', {
          row: r + 2,
          stack: formattedError.stack,
        });
      }
      
      // Log raw error object for maximum debugging capability
      if (inspection.rawError) {
        console.error('[inventory-import] Raw error object', {
          row: r + 2,
          rawError: inspection.rawError,
        });
      }
      
      result.errors.push({
        row: r + 2,
        message: [
          formattedError.message,
          formattedError.code ? `code=${formattedError.code}` : null,
          formattedError.constraint ? `constraint=${formattedError.constraint}` : null,
          formattedError.detail ?? null,
          formattedError.hint ?? null,
        ]
          .filter(Boolean)
          .join(' | '),
        data: mapRowData(rawRow),
      });
    };

    const processBatch = async (tx: TxLike, batchStart: number, batchEndExclusive: number) => {
      const normalizedRows: NormalizedImportRow[] = [];
      const productCandidatesByKey = new Map<string, ProductCandidate>();

      // Pass 1: CPU-only normalization + validation.
      for (let r = batchStart; r < batchEndExclusive; r++) {
        result.totalRows++;
        try {
          const normalizedRow = normalizeRowForImport(r, rows[r]);
          normalizedRows.push(normalizedRow);

          if (!productCache.has(normalizedRow.productKey) && !productCandidatesByKey.has(normalizedRow.productKey)) {
            productCandidatesByKey.set(normalizedRow.productKey, {
              productKey: normalizedRow.productKey,
              game: normalizedRow.game,
              name: normalizedRow.name,
              setName: normalizedRow.setName,
              setCode: normalizedRow.setCode,
              cardNumber: normalizedRow.cardNumber,
              rarity: normalizedRow.rarity,
            });
          }
        } catch (err) {
          handleRowError(r, rows[r], err);
        }
      }

      if (!normalizedRows.length) {
        return {
          validRows: 0,
          productsToInsert: 0,
          skusToInsert: 0,
          inventoryWithCostRows: 0,
          inventoryWithoutCostRows: 0,
          priceRows: 0,
        };
      }

      await bulkInsertProducts(tx, [...productCandidatesByKey.values()]);

      const rowsWithProducts: Array<NormalizedImportRow & { productId: string; skuKey: string }> = [];
      const skuCandidatesByKey = new Map<string, SkuCandidate>();

      for (const row of normalizedRows) {
        const productId = productCache.get(row.productKey);
        if (!productId) {
          handleRowError(row.rowIndex, row.rawRow, new Error('could not resolve product identity after bulk insert'));
          continue;
        }

        const skuKey = skuIdentityKey({
          productId,
          condition: row.condition,
          printing: row.printing,
          language: row.language,
        });

        rowsWithProducts.push({
          ...row,
          productId,
          skuKey,
        });

        if (!skuCache.has(skuKey) && !skuCandidatesByKey.has(skuKey)) {
          const newSkuId = randomUUID();
          skuCandidatesByKey.set(skuKey, {
            skuKey,
            id: newSkuId,
            productId,
            condition: row.condition,
            printing: row.printing,
            language: row.language,
          });
        }
      }

      await bulkInsertSkus(tx, [...skuCandidatesByKey.values()]);

      const inventoryWithCostByKey = new Map<string, { skuId: string; locationId: string; qty: number; costNumerator: number }>();
      const inventoryWithoutCostByKey = new Map<string, { skuId: string; locationId: string; qty: number }>();
      const currentPricesBySkuId = new Map<string, CurrentPricePayload>();

      // Pass 2: resolve sku IDs, classify upsert payloads, and update counters.
      for (const row of rowsWithProducts) {
        const skuId = skuCache.get(row.skuKey);
        if (!skuId) {
          handleRowError(row.rowIndex, row.rawRow, new Error('could not resolve SKU identity after bulk insert'));
          continue;
        }

        const invKey = inventoryIdentityKey({ skuId, locationId: req.locationId });
        if (inventoryPresenceCache.has(invKey)) {
          result.inventoryUpdated++;
        } else {
          result.inventoryCreated++;
          inventoryPresenceCache.add(invKey);
        }

        if (row.costCents != null) {
          result.costsApplied++;

          const existing = inventoryWithCostByKey.get(invKey);
          if (existing) {
            existing.qty += row.qty;
            existing.costNumerator += row.costCents * row.qty;
          } else {
            inventoryWithCostByKey.set(invKey, {
              skuId,
              locationId: req.locationId,
              qty: row.qty,
              costNumerator: row.costCents * row.qty,
            });
          }
        } else {
          const existing = inventoryWithoutCostByKey.get(invKey);
          if (existing) {
            existing.qty += row.qty;
          } else {
            inventoryWithoutCostByKey.set(invKey, {
              skuId,
              locationId: req.locationId,
              qty: row.qty,
            });
          }
        }

        if (row.marketCents != null) {
          if (!currentPricePresenceCache.has(skuId)) {
            result.pricesSeeded++;
            currentPricePresenceCache.add(skuId);
          }
          result.marketPricesApplied++;
          currentPricesBySkuId.set(skuId, {
            skuId,
            marketCents: row.marketCents,
          });
        }
      }

      const inventoryWithCostRows: InventoryWithCostPayload[] = [...inventoryWithCostByKey.values()].map((row) => ({
        skuId: row.skuId,
        locationId: row.locationId,
        qty: row.qty,
        weightedCostCents: Math.round(row.costNumerator / row.qty),
      }));
      const inventoryWithoutCostRows = [...inventoryWithoutCostByKey.values()];
      const priceRows = [...currentPricesBySkuId.values()];

      // Keep exact existing semantics for missing cost by running separate upserts.
      await bulkUpsertInventoryWithCost(tx, inventoryWithCostRows);
      await bulkUpsertInventoryWithoutCost(tx, inventoryWithoutCostRows);
      await bulkUpsertCurrentPrices(tx, priceRows);

      return {
        validRows: normalizedRows.length,
        productsToInsert: productCandidatesByKey.size,
        skusToInsert: skuCandidatesByKey.size,
        inventoryWithCostRows: inventoryWithCostRows.length,
        inventoryWithoutCostRows: inventoryWithoutCostRows.length,
        priceRows: priceRows.length,
      };
    };

    if (req.dryRun) {
      await this.db
        .transaction(async (tx) => {
          await processBatch(tx as TxLike, 0, rows.length);

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

        const batchMetrics = await this.db.transaction(async (tx) =>
          processBatch(tx as TxLike, batchStart, batchEndExclusive),
        );

        console.info('[inventory-import] batch committed', {
          storeId,
          locationId: req.locationId,
          startRow: batchStart + 2,
          endRow: batchEndExclusive + 1,
          rowsProcessed: batchEndExclusive - batchStart,
          validRows: batchMetrics.validRows,
          productsToInsert: batchMetrics.productsToInsert,
          skusToInsert: batchMetrics.skusToInsert,
          inventoryWithCostRows: batchMetrics.inventoryWithCostRows,
          inventoryWithoutCostRows: batchMetrics.inventoryWithoutCostRows,
          priceRows: batchMetrics.priceRows,
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
import { and, eq, gte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  CardCondition,
  CreateTradeRequest,
  PayoutKind,
  TradeItemInput,
} from '@tcg/shared';
import { skuIdentityKey } from '@tcg/shared';
import { schema, type Database } from '../../db/client';
import { BadRequest, NotFound } from '../../common/http-errors';
import { generateBarcodeToken } from '../../common/barcode-token';
import { emitToStore, SOCKET_EVENTS } from '../realtime/socket';
import { InventoryService } from './inventory';

const PAYOUT_MULTIPLIERS: Record<PayoutKind, number> = {
  cash: 0.7,
  store_credit: 0.8,
};

const APPROVAL_THRESHOLD_CENTS = 5_000; // trades above $50 need manager sign-off

function applyPayoutModifierPercent(baseCents: number, modifierPercent?: number): number {
  const modifier = modifierPercent ?? 0;
  return Math.max(0, Math.floor(baseCents * (1 + modifier / 100)));
}

/**
 * Pure helper: trade-in value given best available market signal + condition.
 * Exported so unit tests can exercise it without a DB.
 */
export function computeSuggestedUnitValueCents(args: {
  marketCents: number | null | undefined;
  medianCents: number | null | undefined;
  condition: CardCondition;
  payout: PayoutKind;
  payoutModifierPercent?: number;
}): number {
  const candidates = [args.marketCents, args.medianCents].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );
  const base = candidates.length ? Math.min(...candidates) : 0;
  const mult = PAYOUT_MULTIPLIERS[args.payout];
  return applyPayoutModifierPercent(Math.max(0, Math.floor(base * mult)), args.payoutModifierPercent);
}

export class TradeinsService {
  constructor(
    private readonly db: Database,
    private readonly inventory: InventoryService,
  ) {}

  async suggestUnitValueCents(
    args: {
      skuId: string;
      condition: CardCondition;
      payout: PayoutKind;
        payoutModifierPercent?: number;
    },
    db: Database = this.db,
  ): Promise<number> {
    const [price] = await db
      .select()
      .from(schema.currentPrices)
      .where(eq(schema.currentPrices.skuId, args.skuId));
    return computeSuggestedUnitValueCents({
      marketCents: price?.marketPriceCents,
      medianCents: price?.marketMedianCents,
      condition: args.condition,
      payout: args.payout,
      payoutModifierPercent: args.payoutModifierPercent,
    });
  }

  async create(args: { storeId: string; userId: string; body: CreateTradeRequest }) {
    const { storeId, body } = args;
    if (body.items.length === 0) throw BadRequest('no items');

    // Per-customer anti-abuse: cap to $1000/week.
    if (body.customerId) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const [agg] = await this.db
        .select({ total: sql<number>`coalesce(sum(${schema.tradeIns.totalValueCents}), 0)` })
        .from(schema.tradeIns)
        .where(
          and(
            eq(schema.tradeIns.storeId, storeId),
            eq(schema.tradeIns.customerId, body.customerId),
            gte(schema.tradeIns.createdAt, sevenDaysAgo),
          ),
        );
      if ((agg?.total ?? 0) > 100_000) {
        throw BadRequest('customer weekly trade-in cap exceeded');
      }
    }

    const trade = await this.db.transaction(async (tx) => {
      let total = 0;
      let totalMarket = 0;
      const lineRows: Array<{
        skuId: string;
        qty: number;
        unitValueCents: number;
        marketPriceCents: number | null;
      }> = [];

      for (const item of body.items) {
        const imageSourceUrl = (item as TradeItemInput & { imageSourceUrl?: string | null })
          .imageSourceUrl;
        const rarity = (item as TradeItemInput & { rarity?: string | null }).rarity;
        const skuId = item.skuId ?? (await this.upsertSku(tx, storeId, item, imageSourceUrl, rarity));
        const payoutModifierPercent =
          (item as TradeItemInput & { payoutModifierPercent?: number }).payoutModifierPercent;
        const marketPriceCentsRaw =
          (item as TradeItemInput & { marketPriceCents?: number | null }).marketPriceCents;
        const marketPriceCents =
          typeof marketPriceCentsRaw === 'number' && marketPriceCentsRaw >= 0
            ? Math.floor(marketPriceCentsRaw)
            : null;
        const unit =
          item.overrideValueCents ??
          (await this.suggestUnitValueCents(
            {
              skuId,
              condition: item.condition,
              payout: body.payout,
              payoutModifierPercent,
            },
            tx,
          ));
        total += unit * item.quantity;
        totalMarket += (marketPriceCents ?? unit) * item.quantity;
        lineRows.push({
          skuId,
          qty: item.quantity,
          unitValueCents: unit,
          marketPriceCents,
        });
      }

      const status = total >= APPROVAL_THRESHOLD_CENTS ? 'pending_approval' : 'approved';
      const [trd] = await tx
        .insert(schema.tradeIns)
        .values({
          storeId,
          locationId: body.locationId,
          customerId: body.customerId,
          payout: body.payout,
          status,
          totalValueCents: total,
          totalBuyValueCents: total,
          totalMarketValueCents: totalMarket,
          barcode: generateBarcodeToken('TRD'),
          createdBy: args.userId,
        })
        .returning();
      if (!trd) throw new Error('failed to create trade');

      for (const l of lineRows) {
        await tx.insert(schema.tradeItems).values({
          tradeId: trd.id,
          skuId: l.skuId,
          quantity: l.qty,
          unitValueCents: l.unitValueCents,
          marketPriceCents: l.marketPriceCents,
          barcode: generateBarcodeToken('TLI'),
        });
      }
      // Surface the resulting SKUs so the caller can immediately print labels
      // for the cards they just took in.
      return { ...trd, lineRows };
    });

    if (trade.status === 'approved') {
      await this.finalize(trade.id);
    }

    emitToStore(storeId, SOCKET_EVENTS.tradeCreated, {
      tradeId: trade.id,
      totalValueCents: trade.totalValueCents,
      status: trade.status,
    });

    const { lineRows: _lineRows, ...tradeRow } = trade;
    return {
      ...tradeRow,
      skuIds: trade.lineRows.map((l) => ({ skuId: l.skuId, quantity: l.qty })),
    };
  }

  async approve(args: { storeId: string; tradeId: string; userId: string }) {
    // Atomically claim the trade for approval so two managers can't both push it
    // forward (only one row will match `pending_approval` after the first wins).
    const claimed = await this.db
      .update(schema.tradeIns)
      .set({ status: 'approved', approvedBy: args.userId })
      .where(
        and(
          eq(schema.tradeIns.id, args.tradeId),
          eq(schema.tradeIns.storeId, args.storeId),
          eq(schema.tradeIns.status, 'pending_approval'),
        ),
      )
      .returning({ id: schema.tradeIns.id, totalValueCents: schema.tradeIns.totalValueCents });
    if (claimed.length === 0) {
      // Either the trade doesn't belong to this store, doesn't exist, or has
      // already been advanced past `pending_approval`. Reflect that to the caller.
      const [existing] = await this.db
        .select({ status: schema.tradeIns.status })
        .from(schema.tradeIns)
        .where(
          and(eq(schema.tradeIns.id, args.tradeId), eq(schema.tradeIns.storeId, args.storeId)),
        );
      if (!existing) throw NotFound('trade not found');
      throw BadRequest(`trade is ${existing.status}`);
    }
    const trade = claimed[0]!;
    await this.finalize(trade.id);
    emitToStore(args.storeId, SOCKET_EVENTS.tradeApproved, {
      tradeId: trade.id,
      totalValueCents: trade.totalValueCents,
      status: 'approved',
    });
    return { ok: true };
  }

  private async finalize(tradeId: string): Promise<void> {
    // Atomically claim the trade for finalization. Only one caller will see a
    // returned row; concurrent callers receive `[]` and exit without double-receiving
    // inventory or double-crediting the customer.
    const claimed = await this.db
      .update(schema.tradeIns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(and(eq(schema.tradeIns.id, tradeId), eq(schema.tradeIns.status, 'approved')))
      .returning();
    const trade = claimed[0];
    if (!trade) return;

    const items = await this.db
      .select()
      .from(schema.tradeItems)
      .where(eq(schema.tradeItems.tradeId, tradeId));
    for (const item of items) {
      await this.inventory.receive({
        storeId: trade.storeId,
        skuId: item.skuId,
        locationId: trade.locationId,
        qty: item.quantity,
        costCents: item.unitValueCents,
        marketPriceCents: item.marketPriceCents,
      });
    }

    if (trade.payout === 'store_credit' && trade.customerId) {
      await this.db
        .update(schema.customers)
        .set({
          storeCreditCents: sql`${schema.customers.storeCreditCents} + ${trade.totalValueCents}`,
        })
        .where(eq(schema.customers.id, trade.customerId));
    }
  }

  /**
   * Look up an existing SKU by identity tuple, or create a new product+SKU
   * for the trade-in when the card is new to the store.
   */
  private async upsertSku(
    tx: Database,
    storeId: string,
    item: TradeItemInput,
    imageSourceUrl?: string | null,
    rarity?: string | null,
  ): Promise<string> {
    if (!item.tcgapiProductId) {
      throw BadRequest('item must include skuId or tcgapiProductId for new card intake');
    }
    const identity = skuIdentityKey({
      tcgapiProductId: item.tcgapiProductId,
      condition: item.condition,
      printing: item.printing,
      language: item.language,
    });

    let [product] = await tx
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.storeId, storeId),
          eq(schema.products.tcgapiProductId, item.tcgapiProductId),
        ),
      );
    if (!product) {
      [product] = await tx
        .insert(schema.products)
        .values({
          storeId,
          tcgapiProductId: item.tcgapiProductId,
          game: item.game ?? 'other',
          name: item.name ?? `TCGapi ${item.tcgapiProductId}`,
          imageSourceUrl,
          rarity: rarity ?? null,
        })
        .returning();
    }
    if (!product) throw new Error('failed to create product');

    if (imageSourceUrl && !product.imageSourceUrl) {
      [product] = await tx
        .update(schema.products)
        .set({ imageSourceUrl, updatedAt: new Date() })
        .where(eq(schema.products.id, product.id))
        .returning();
      if (!product) throw new Error('failed to update product image');
    }
    if (rarity && !product.rarity) {
      [product] = await tx
        .update(schema.products)
        .set({ rarity, updatedAt: new Date() })
        .where(eq(schema.products.id, product.id))
        .returning();
      if (!product) throw new Error('failed to update product rarity');
    }

    const [existing] = await tx
      .select()
      .from(schema.skus)
      .where(
        and(
          eq(schema.skus.productId, product.id),
          eq(schema.skus.condition, item.condition),
          eq(schema.skus.printing, item.printing),
          eq(schema.skus.language, item.language),
        ),
      );
    if (existing) return existing.id;
    // Pre-generate the SKU UUID so the barcode column can mirror it. This
    // keeps barcode lookups index-only while letting any future scanner work
    // by id direc
    const skuId = crypto.randomUUID();
    const [created] = await tx
      .insert(schema.skus)
      .values({
        id: skuId,
        productId: product.id,
        storeId,
        condition: item.condition,
        printing: item.printing,
        language: item.language,
        barcode: skuId,
        internalSku: identity,
      })
      .returning();
    if (!created) throw new Error('failed to create sku');
    return created.id;
  }
}

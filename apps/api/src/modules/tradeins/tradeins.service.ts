import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { CreateTradeRequest, CardCondition, CardPrinting, CardLanguage } from '@tcg/shared';
import { skuIdentityKey } from '@tcg/shared';
import { DRIZZLE } from '../../db/database.module';
import { schema } from '../../db/client';
import type { Database } from '../../db/client';
import { InventoryService } from '../inventory/inventory.service';
import { RealtimeGateway, SOCKET_EVENTS } from '../realtime/realtime.gateway';
import { generateBarcodeToken } from '../../common/barcode-token';

/**
 * Trade-In valuation tiers.
 * The store's policy can override these via env or admin UI later.
 */
const PAYOUT_MULTIPLIERS: Record<'cash' | 'store_credit', Record<CardCondition, number>> = {
  cash: { NM: 0.4, LP: 0.35, MP: 0.3, HP: 0.2, DMG: 0.1 },
  store_credit: { NM: 0.6, LP: 0.55, MP: 0.5, HP: 0.35, DMG: 0.2 },
};

const APPROVAL_THRESHOLD_CENTS = 5_000; // trades above $50 need manager sign-off

@Injectable()
export class TradeinsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Compute suggested trade value (cents per unit) for a SKU using
   * `min(tcgplayer_market, ebay_30d_median)` × tier multiplier.
   */
  async suggestUnitValueCents(args: {
    skuId: string;
    condition: CardCondition;
    payout: 'cash' | 'store_credit';
  }): Promise<number> {
    const [price] = await this.db
      .select()
      .from(schema.currentPrices)
      .where(eq(schema.currentPrices.skuId, args.skuId));
    const market = price?.marketPriceCents ?? 0;
    const ebay = price?.ebay30dMedianCents ?? 0;
    const candidates = [market, ebay].filter((n) => n > 0);
    const base = candidates.length ? Math.min(...candidates) : 0;
    const mult = PAYOUT_MULTIPLIERS[args.payout][args.condition];
    return Math.max(0, Math.floor(base * mult));
  }

  /**
   * Create a trade-in, creating SKUs on the fly when items don't yet exist
   * in the store catalog. Generates a per-trade and per-item barcode.
   */
  async create(args: {
    storeId: string;
    userId: string;
    body: CreateTradeRequest;
  }) {
    const { storeId, body } = args;
    if (body.items.length === 0) throw new BadRequestException('no items');

    // Per-customer anti-abuse: cap to $1000/week.
    if (body.customerId) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const [agg] = await this.db
        .select({ total: sql<number>`coalesce(sum(${schema.tradeIns.totalValueCents}), 0)` })
        .from(schema.tradeIns)
        .where(
          and(
            eq(schema.tradeIns.customerId, body.customerId),
            gte(schema.tradeIns.createdAt, sevenDaysAgo),
          ),
        );
      if ((agg?.total ?? 0) > 100_000) {
        throw new BadRequestException('customer weekly trade-in cap exceeded');
      }
    }

    const trade = await this.db.transaction(async (tx) => {
      let total = 0;
      const lineRows: Array<{ skuId: string; qty: number; unitValueCents: number }> = [];

      for (const item of body.items) {
        const skuId = item.skuId ?? (await this.upsertSku(tx, storeId, item));
        const unit =
          item.overrideValueCents ??
          (await this.suggestUnitValueCents({
            skuId,
            condition: item.condition,
            payout: body.payout,
          }));
        total += unit * item.quantity;
        lineRows.push({ skuId, qty: item.quantity, unitValueCents: unit });
      }

      const status = total >= APPROVAL_THRESHOLD_CENTS ? 'pending_approval' : 'approved';
      const tradeBarcode = generateBarcodeToken('TRD');
      const [trd] = await tx
        .insert(schema.tradeIns)
        .values({
          storeId,
          locationId: body.locationId,
          customerId: body.customerId,
          payout: body.payout,
          status,
          totalValueCents: total,
          barcode: tradeBarcode,
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
          barcode: generateBarcodeToken('TLI'),
        });
      }
      return trd;
    });

    // Auto-approve path: receive inventory + (for store_credit) bump the customer balance.
    if (trade.status === 'approved') {
      await this.finalize(trade.id);
    }

    this.realtime.emitToStore(storeId, SOCKET_EVENTS.tradeCreated, {
      tradeId: trade.id,
      totalValueCents: trade.totalValueCents,
      status: trade.status,
    });

    return trade;
  }

  async approve(args: { storeId: string; tradeId: string; userId: string }) {
    const [trade] = await this.db
      .select()
      .from(schema.tradeIns)
      .where(
        and(
          eq(schema.tradeIns.id, args.tradeId),
          eq(schema.tradeIns.storeId, args.storeId),
        ),
      );
    if (!trade) throw new NotFoundException('trade not found');
    if (trade.status !== 'pending_approval') {
      throw new BadRequestException(`trade is ${trade.status}`);
    }
    await this.db
      .update(schema.tradeIns)
      .set({ status: 'approved', approvedBy: args.userId })
      .where(eq(schema.tradeIns.id, trade.id));
    await this.finalize(trade.id);
    this.realtime.emitToStore(args.storeId, SOCKET_EVENTS.tradeApproved, {
      tradeId: trade.id,
      totalValueCents: trade.totalValueCents,
      status: 'approved',
    });
    return { ok: true };
  }

  /** Receive inventory + payout. Idempotent: marks status 'completed'. */
  private async finalize(tradeId: string) {
    const [trade] = await this.db
      .select()
      .from(schema.tradeIns)
      .where(eq(schema.tradeIns.id, tradeId));
    if (!trade) return;
    if (trade.status === 'completed') return;
    if (trade.status !== 'approved') return;

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
    // Cash payout: caller is responsible for opening the cash drawer via POS.

    await this.db
      .update(schema.tradeIns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tradeIns.id, trade.id));
  }

  /**
   * Look up an existing SKU by identity tuple, or create a new product+SKU
   * for the trade-in when the card is new to the store.
   */
  private async upsertSku(
    tx: Database,
    storeId: string,
    item: {
      tcgplayerProductId?: number;
      condition: CardCondition;
      printing: CardPrinting;
      language: CardLanguage;
    },
  ): Promise<string> {
    if (!item.tcgplayerProductId) {
      throw new BadRequestException(
        'item must include skuId or tcgplayerProductId for new card intake',
      );
    }
    const identity = skuIdentityKey({
      tcgplayerProductId: item.tcgplayerProductId,
      condition: item.condition,
      printing: item.printing,
      language: item.language,
    });

    // Find or create the product.
    let [product] = await tx
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.storeId, storeId),
          eq(schema.products.tcgplayerProductId, item.tcgplayerProductId),
        ),
      );
    if (!product) {
      [product] = await tx
        .insert(schema.products)
        .values({
          storeId,
          tcgplayerProductId: item.tcgplayerProductId,
          name: `TCGplayer #${item.tcgplayerProductId}`,
        })
        .returning();
    }
    if (!product) throw new Error('failed to create product');

    // Find or create the SKU.
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
    const [created] = await tx
      .insert(schema.skus)
      .values({
        productId: product.id,
        storeId,
        condition: item.condition,
        printing: item.printing,
        language: item.language,
        barcode: generateBarcodeToken('TCG'),
        internalSku: identity,
      })
      .returning();
    if (!created) throw new Error('failed to create sku');
    return created.id;
  }
}

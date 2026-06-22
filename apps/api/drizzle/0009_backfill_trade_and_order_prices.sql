-- Backfill historical trade-ins and register sales that were written before
-- market-price persistence and market-first register pricing were fixed.

-- 1) Repair trade-item payout values when the line captured a market price but
--    the computed buy value was stored as 0.
WITH repaired_trade_items AS (
  SELECT
    ti.id,
    CASE tr.payout
      WHEN 'cash' THEN floor(ti.market_price_cents * 0.7)
      WHEN 'store_credit' THEN floor(ti.market_price_cents * 0.8)
      ELSE ti.unit_value_cents
    END::integer AS computed_unit_value_cents
  FROM trade_items ti
  INNER JOIN trade_ins tr ON tr.id = ti.trade_id
  WHERE coalesce(ti.unit_value_cents, 0) = 0
    AND coalesce(ti.market_price_cents, 0) > 0
)
UPDATE trade_items ti
SET unit_value_cents = repaired_trade_items.computed_unit_value_cents
FROM repaired_trade_items
WHERE ti.id = repaired_trade_items.id;

-- 2) Seed or repair current_prices from the latest known trade-in market price
--    so future scans have a usable market/sell price.
WITH latest_trade_prices AS (
  SELECT DISTINCT ON (ti.sku_id)
    ti.sku_id,
    ti.market_price_cents
  FROM trade_items ti
  WHERE coalesce(ti.market_price_cents, 0) > 0
  ORDER BY ti.sku_id, ti.created_at DESC, ti.id DESC
)
INSERT INTO current_prices (
  sku_id,
  sell_price_cents,
  buy_price_cents,
  market_price_cents,
  market_median_cents,
  updated_at
)
SELECT
  latest_trade_prices.sku_id,
  latest_trade_prices.market_price_cents,
  0,
  latest_trade_prices.market_price_cents,
  latest_trade_prices.market_price_cents,
  now()
FROM latest_trade_prices
ON CONFLICT (sku_id) DO UPDATE
SET
  sell_price_cents = CASE
    WHEN current_prices.sell_price_cents <= 0 THEN excluded.sell_price_cents
    ELSE current_prices.sell_price_cents
  END,
  market_price_cents = coalesce(current_prices.market_price_cents, excluded.market_price_cents),
  market_median_cents = coalesce(current_prices.market_median_cents, excluded.market_median_cents),
  updated_at = now();

-- 3) Recompute trade headers from their line items so analytics and reports use
--    the real buy total and market total.
WITH trade_totals AS (
  SELECT
    ti.trade_id,
    coalesce(sum(ti.quantity * ti.unit_value_cents), 0)::integer AS total_buy_value_cents,
    coalesce(sum(ti.quantity * coalesce(ti.market_price_cents, ti.unit_value_cents)), 0)::integer AS total_market_value_cents
  FROM trade_items ti
  GROUP BY ti.trade_id
)
UPDATE trade_ins tr
SET
  total_value_cents = trade_totals.total_buy_value_cents,
  total_buy_value_cents = trade_totals.total_buy_value_cents,
  total_market_value_cents = trade_totals.total_market_value_cents
FROM trade_totals
WHERE tr.id = trade_totals.trade_id;

-- 4) Repair historical register lines that recorded 0 sale price by using the
--    best available market price for that SKU.
WITH effective_order_prices AS (
  SELECT
    oi.id,
    coalesce(
      cp.market_price_cents,
      cp.sell_price_cents,
      latest_trade.market_price_cents
    ) AS corrected_unit_price_cents
  FROM order_items oi
  LEFT JOIN current_prices cp ON cp.sku_id = oi.sku_id
  LEFT JOIN LATERAL (
    SELECT ti.market_price_cents
    FROM trade_items ti
    WHERE ti.sku_id = oi.sku_id
      AND coalesce(ti.market_price_cents, 0) > 0
    ORDER BY ti.created_at DESC, ti.id DESC
    LIMIT 1
  ) latest_trade ON true
  WHERE coalesce(oi.unit_price_cents, 0) <= 0
)
UPDATE order_items oi
SET unit_price_cents = effective_order_prices.corrected_unit_price_cents
FROM effective_order_prices
WHERE oi.id = effective_order_prices.id
  AND coalesce(effective_order_prices.corrected_unit_price_cents, 0) > 0;

-- 5) Recompute order totals from the repaired line items.
WITH order_totals AS (
  SELECT
    oi.order_id,
    coalesce(sum((oi.quantity * oi.unit_price_cents) - oi.discount_cents), 0)::integer AS subtotal_cents
  FROM order_items oi
  GROUP BY oi.order_id
)
UPDATE orders o
SET
  subtotal_cents = order_totals.subtotal_cents,
  tax_cents = 0,
  total_cents = order_totals.subtotal_cents
FROM order_totals
WHERE o.id = order_totals.order_id;

ALTER TABLE trade_ins
  ADD COLUMN IF NOT EXISTS total_buy_value_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_market_value_cents integer NOT NULL DEFAULT 0;

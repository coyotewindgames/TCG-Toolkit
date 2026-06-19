alter table trade_items
  add column if not exists market_price_cents integer;

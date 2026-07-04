-- New price sources for PkmnPrices.com data. Add BEFORE 'manual_override'
-- so the enum ordering matches the desired coalesce preference in
-- PricingService.recomputeCurrent (override always wins regardless of
-- position, but it reads cleaner with the manual escape hatch last).
ALTER TYPE price_source ADD VALUE IF NOT EXISTS 'pkmnprices_market' BEFORE 'manual_override';
ALTER TYPE price_source ADD VALUE IF NOT EXISTS 'pkmnprices_low' BEFORE 'manual_override';
ALTER TYPE price_source ADD VALUE IF NOT EXISTS 'pkmnprices_cardmarket' BEFORE 'manual_override';

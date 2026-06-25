ALTER TABLE tcgapi_configs
  ADD COLUMN IF NOT EXISTS query_game_slugs text[] NOT NULL DEFAULT ARRAY[]::text[];

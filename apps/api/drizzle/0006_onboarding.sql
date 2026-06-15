-- Track whether the owner has completed the onboarding wizard.
-- NULL means onboarding is still in progress.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

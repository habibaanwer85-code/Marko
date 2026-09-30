-- ============================================================
-- MARKO — Subscriptions table (adds to your existing project)
-- ============================================================
-- Run this in Supabase SQL Editor. Only ADDS a new table.

create table if not exists subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text default 'free',           -- 'free' | 'active' | 'past_due' | 'canceled'
  plan text default 'free',             -- 'free' | 'pro'
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz default now()
);

alter table subscriptions enable row level security;

-- Users can only READ their own subscription status.
-- Writes only happen via the Stripe webhook, using the service_role key
-- (which bypasses RLS entirely) — so a user can never edit their own row
-- to fake a Pro upgrade.
create policy "subscriptions_select_own" on subscriptions
  for select using (auth.uid() = user_id);

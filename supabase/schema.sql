-- WordFlow cloud sync schema.
-- Run this once in Supabase -> SQL Editor before deploying the cloud-enabled app.

create table if not exists public.wordflow_device_state (
  -- Supabase assigns this ID after the user opens their passwordless email link.
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- A complete, validated app snapshot keeps the cloud model intentionally small.
  payload jsonb not null default '{"items": [], "settings": {}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.wordflow_device_state enable row level security;

-- Passwordless email users receive the authenticated role after they open
-- their sign-in link. They can read and write only their own cloud record.
grant select, insert, update on public.wordflow_device_state to authenticated;

drop policy if exists "device_state_select_own" on public.wordflow_device_state;
create policy "device_state_select_own"
on public.wordflow_device_state for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "device_state_insert_own" on public.wordflow_device_state;
create policy "device_state_insert_own"
on public.wordflow_device_state for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "device_state_update_own" on public.wordflow_device_state;
create policy "device_state_update_own"
on public.wordflow_device_state for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Closed-app push is scoped to the signed-in account. Browser subscription
-- credentials are private, so RLS prevents another account from reading or
-- replacing a device's subscription.
create table if not exists public.wordflow_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null,
  reminder_times text[] not null,
  timezone text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wordflow_push_subscriptions enable row level security;
grant select, insert, update, delete on public.wordflow_push_subscriptions to authenticated;

drop policy if exists "push_subscriptions_select_own" on public.wordflow_push_subscriptions;
create policy "push_subscriptions_select_own"
on public.wordflow_push_subscriptions for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "push_subscriptions_insert_own" on public.wordflow_push_subscriptions;
create policy "push_subscriptions_insert_own"
on public.wordflow_push_subscriptions for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "push_subscriptions_update_own" on public.wordflow_push_subscriptions;
create policy "push_subscriptions_update_own"
on public.wordflow_push_subscriptions for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "push_subscriptions_delete_own" on public.wordflow_push_subscriptions;
create policy "push_subscriptions_delete_own"
on public.wordflow_push_subscriptions for delete to authenticated
using ((select auth.uid()) = user_id);

-- The scheduled sender uses this service-only table to ensure a retry cannot
-- show the same reminder twice. There are deliberately no browser grants or
-- policies; Netlify's service-role key bypasses RLS on the server only.
create table if not exists public.wordflow_push_deliveries (
  subscription_endpoint text not null references public.wordflow_push_subscriptions(endpoint) on delete cascade,
  delivery_key text not null,
  created_at timestamptz not null default now(),
  primary key (subscription_endpoint, delivery_key)
);

alter table public.wordflow_push_deliveries enable row level security;

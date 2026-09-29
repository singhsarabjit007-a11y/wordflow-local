-- WordFlow cloud sync schema.
-- Run this once in Supabase -> SQL Editor before deploying the cloud-enabled app.

create table if not exists public.wordflow_device_state (
  -- auth.users also contains anonymous users. The browser never chooses this ID.
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- A complete, validated app snapshot keeps the cloud model intentionally small.
  payload jsonb not null default '{"items": [], "settings": {}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.wordflow_device_state enable row level security;

-- Anonymous Supabase users receive the authenticated role after their silent
-- sign-in. They can read and write only the row whose ID matches their session.
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

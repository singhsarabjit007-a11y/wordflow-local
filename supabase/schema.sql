-- WordFlow V1 schema
-- Run this once in Supabase -> SQL Editor.

create extension if not exists pgcrypto;

do $$ begin
  create type public.wordflow_status as enum ('queued', 'active', 'review', 'learned');
exception when duplicate_object then null;
end $$;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'Asia/Kolkata',
  notifications_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.learning_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  topic text not null default '',
  difficulty text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.vocabulary_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pack_id uuid references public.learning_packs(id) on delete set null,
  term text not null,
  term_normalized text not null,
  item_type text not null,
  meaning text not null,
  explanation text not null default '',
  category text not null default '',
  difficulty text not null default '',
  status public.wordflow_status not null default 'queued',
  queue_position bigint not null,
  started_on date,
  learned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, term_normalized)
);

create index if not exists vocabulary_items_queue_idx on public.vocabulary_items(user_id, status, queue_position);
create index if not exists vocabulary_items_pack_idx on public.vocabulary_items(pack_id);

create table if not exists public.examples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vocabulary_item_id uuid not null references public.vocabulary_items(id) on delete cascade,
  example_index smallint not null check (example_index between 1 and 5),
  sentence text not null,
  unique (vocabulary_item_id, example_index)
);

create table if not exists public.daily_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  learning_date date not null,
  vocabulary_item_id uuid not null references public.vocabulary_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, learning_date)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vocabulary_item_id uuid not null references public.vocabulary_items(id) on delete cascade,
  learning_date date not null,
  slot smallint not null check (slot between 1 and 5),
  sent_at timestamptz not null default now(),
  unique (user_id, vocabulary_item_id, learning_date, slot)
);

-- Create a settings row for each new account.
create or replace function public.handle_new_wordflow_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_settings(user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_wordflow on auth.users;
create trigger on_auth_user_created_wordflow
after insert on auth.users
for each row execute procedure public.handle_new_wordflow_user();

-- Backfill settings if you created the login before running this script.
insert into public.user_settings(user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- RLS
alter table public.user_settings enable row level security;
alter table public.learning_packs enable row level security;
alter table public.vocabulary_items enable row level security;
alter table public.examples enable row level security;
alter table public.daily_assignments enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log enable row level security;

-- Least-privilege grants for browser users. service_role bypasses RLS.
revoke all on public.user_settings, public.learning_packs, public.vocabulary_items, public.examples, public.daily_assignments, public.push_subscriptions, public.notification_log from anon, authenticated;
grant select, update on public.user_settings to authenticated;
grant select, insert, update, delete on public.learning_packs to authenticated;
grant select, insert, update, delete on public.vocabulary_items to authenticated;
grant select, insert, update, delete on public.examples to authenticated;
grant select, insert, update, delete on public.daily_assignments to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select on public.notification_log to authenticated;
grant all on public.user_settings, public.learning_packs, public.vocabulary_items, public.examples, public.daily_assignments, public.push_subscriptions, public.notification_log to service_role;

-- Policies: user_settings
create policy "settings_select_own" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "settings_update_own" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Policies: learning_packs
create policy "packs_select_own" on public.learning_packs for select to authenticated using ((select auth.uid()) = user_id);
create policy "packs_insert_own" on public.learning_packs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "packs_update_own" on public.learning_packs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "packs_delete_own" on public.learning_packs for delete to authenticated using ((select auth.uid()) = user_id);

-- Policies: vocabulary_items
create policy "items_select_own" on public.vocabulary_items for select to authenticated using ((select auth.uid()) = user_id);
create policy "items_insert_own" on public.vocabulary_items for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and (pack_id is null or exists (
    select 1 from public.learning_packs p where p.id = pack_id and p.user_id = (select auth.uid())
  ))
);
create policy "items_update_own" on public.vocabulary_items for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and (pack_id is null or exists (
    select 1 from public.learning_packs p where p.id = pack_id and p.user_id = (select auth.uid())
  ))
);
create policy "items_delete_own" on public.vocabulary_items for delete to authenticated using ((select auth.uid()) = user_id);

-- Policies: examples
create policy "examples_select_own" on public.examples for select to authenticated using ((select auth.uid()) = user_id);
create policy "examples_insert_own" on public.examples for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.vocabulary_items v where v.id = vocabulary_item_id and v.user_id = (select auth.uid())
  )
);
create policy "examples_update_own" on public.examples for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.vocabulary_items v where v.id = vocabulary_item_id and v.user_id = (select auth.uid())
  )
);
create policy "examples_delete_own" on public.examples for delete to authenticated using ((select auth.uid()) = user_id);

-- Policies: daily_assignments
create policy "assignments_select_own" on public.daily_assignments for select to authenticated using ((select auth.uid()) = user_id);
create policy "assignments_insert_own" on public.daily_assignments for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.vocabulary_items v where v.id = vocabulary_item_id and v.user_id = (select auth.uid())
  )
);
create policy "assignments_update_own" on public.daily_assignments for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.vocabulary_items v where v.id = vocabulary_item_id and v.user_id = (select auth.uid())
  )
);
create policy "assignments_delete_own" on public.daily_assignments for delete to authenticated using ((select auth.uid()) = user_id);

-- Policies: push_subscriptions
create policy "push_select_own" on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "push_insert_own" on public.push_subscriptions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "push_update_own" on public.push_subscriptions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "push_delete_own" on public.push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);

-- Browser can read its delivery history; only the Netlify service role writes it.
create policy "notification_log_select_own" on public.notification_log for select to authenticated using ((select auth.uid()) = user_id);

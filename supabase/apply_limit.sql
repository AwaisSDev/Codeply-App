-- ============================================================
--  Codeply — Daily Apply Limit (500 applies / user / UTC day)
--  Run this in Supabase → SQL Editor (one time).
--
--  Counts each successful file write (single-file apply = 1 row,
--  multi-file apply = 1 row per file written), so a signed-in user
--  can apply at most 500 changes per day. Enforced in main.js right
--  before each write; this table is what it checks against.
-- ============================================================

-- 1) The apply_history table.
create table if not exists public.apply_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  file_path   text,
  created_at  timestamptz not null default now()
);

create index if not exists apply_history_user_created_idx
  on public.apply_history (user_id, created_at desc);

-- 2) Row-level security — a user can only ever see/insert their own rows.
alter table public.apply_history enable row level security;

drop policy if exists "apply_history_insert_own" on public.apply_history;
create policy "apply_history_insert_own" on public.apply_history
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "apply_history_select_own" on public.apply_history;
create policy "apply_history_select_own" on public.apply_history
  for select to authenticated
  using (auth.uid() = user_id);

-- 3) Fast count of today's applies for the CURRENT user (UTC calendar day).
--    security definer + auth.uid() internally means a user can only ever
--    get their own count back, no matter what — there's no user_id param
--    to spoof.
create or replace function public.get_daily_apply_count()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
  from public.apply_history
  where user_id = auth.uid()
    and created_at >= date_trunc('day', now() at time zone 'utc')
    and created_at <  date_trunc('day', now() at time zone 'utc') + interval '1 day';
$$;

revoke all on function public.get_daily_apply_count() from public;
grant execute on function public.get_daily_apply_count() to authenticated;

-- 4) (Optional) house-keeping — apply_history grows forever otherwise.
--    Run manually, or wire up as a scheduled Supabase cron job, to drop
--    rows older than 30 days (only ever need "today" for the cap check).
-- delete from public.apply_history where created_at < now() - interval '30 days';

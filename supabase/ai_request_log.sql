-- ============================================================
--  Codeply — Daily AI Request Cap (400 raw AI calls / user / UTC day)
--  Run this in Supabase → SQL Editor (one time).
--
--  Separate from apply_history/get_daily_apply_count(): this counts every
--  raw call through the ai-proxy edge function (edits, detection, merges),
--  whether or not the result ever gets applied — a single instruction can
--  cost several raw calls (self-correction retries, surgical-edit-then-
--  full-rewrite fallback), so this cap must be higher than the 100/day
--  apply cap. Enforced INSIDE the edge function itself (not client-side),
--  since the app no longer holds a Groq/OpenRouter key to call directly —
--  this is what actually protects the shared key's budget.
-- ============================================================

-- 1) The ai_request_log table.
create table if not exists public.ai_request_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists ai_request_log_user_created_idx
  on public.ai_request_log (user_id, created_at desc);

-- 2) Row-level security — a user can only ever see/insert their own rows.
alter table public.ai_request_log enable row level security;

drop policy if exists "ai_request_log_insert_own" on public.ai_request_log;
create policy "ai_request_log_insert_own" on public.ai_request_log
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "ai_request_log_select_own" on public.ai_request_log;
create policy "ai_request_log_select_own" on public.ai_request_log
  for select to authenticated
  using (auth.uid() = user_id);

-- 3) Fast count of today's AI requests for the CURRENT user (UTC day).
--    security definer + auth.uid() internally, same as get_daily_apply_count()
--    — no user_id param to spoof.
create or replace function public.get_daily_ai_request_count()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
  from public.ai_request_log
  where user_id = auth.uid()
    and created_at >= date_trunc('day', now() at time zone 'utc')
    and created_at <  date_trunc('day', now() at time zone 'utc') + interval '1 day';
$$;

revoke all on function public.get_daily_ai_request_count() from public;
grant execute on function public.get_daily_ai_request_count() to authenticated;

-- 4) Records one AI request toward the cap. Called by the ai-proxy edge
--    function (running as the calling user via their JWT, same as any other
--    authenticated insert) right before it calls Groq/OpenRouter.
--    security definer + auth.uid() internally — a user can only ever record
--    a row for themselves.
create or replace function public.record_ai_request()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_request_log (user_id) values (auth.uid());
$$;

revoke all on function public.record_ai_request() from public;
grant execute on function public.record_ai_request() to authenticated;

-- 5) (Optional) house-keeping — ai_request_log grows forever otherwise.
--    Run manually, or wire up as a scheduled Supabase cron job, to drop
--    rows older than 30 days (only ever need "today" for the cap check).
-- delete from public.ai_request_log where created_at < now() - interval '30 days';

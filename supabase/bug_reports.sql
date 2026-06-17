-- ============================================================
--  Codeply — Bug Reports + Admin
--  Run this in Supabase → SQL Editor (one time).
-- ============================================================

-- 1) Admin flag on profiles (any user you flag becomes an admin).
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- 2) Make the first admin.  (Change the email to add more admins later.)
update public.profiles
  set is_admin = true
  where id = (select id from auth.users where email = 'mawais9171@gmail.com');

-- 3) The bug_reports table.
create table if not exists public.bug_reports (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null,
  user_email  text,
  title       text,
  description text,
  app_version text,
  status      text not null default 'open'
);

-- 4) Row-level security.
alter table public.bug_reports enable row level security;

-- Any signed-in user can submit their own report.
drop policy if exists "bug_insert_own" on public.bug_reports;
create policy "bug_insert_own" on public.bug_reports
  for insert to authenticated
  with check (auth.uid() = user_id);

-- A user can read their own reports; an admin can read everyone's.
drop policy if exists "bug_select_own_or_admin" on public.bug_reports;
create policy "bug_select_own_or_admin" on public.bug_reports
  for select to authenticated
  using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Only admins can change a report's status.
drop policy if exists "bug_update_admin" on public.bug_reports;
create policy "bug_update_admin" on public.bug_reports
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- 5) (If your profiles table doesn't already let users read their own row, add this.)
-- drop policy if exists "profiles_select_own" on public.profiles;
-- create policy "profiles_select_own" on public.profiles
--   for select to authenticated using (auth.uid() = id);

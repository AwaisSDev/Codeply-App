-- ============================================================
--  Codeply — "Where did you hear about us" referral tracking
--  Run this in Supabase → SQL Editor (one time).
-- ============================================================

-- 1) Column on profiles to hold the answer (YouTube, Instagram, TikTok, Twitter/X, or free text).
alter table public.profiles
  add column if not exists referral_source text;

-- 2) Let a signed-in user update their own profile row (needed for the app to write this field).
--    Skip this if you already have a general "users can update their own profile" policy.
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 3) Quick breakdown of where signups are coming from.
-- select referral_source, count(*) from public.profiles group by referral_source order by count(*) desc;

-- 4) Let an admin read every profile row (needed so the Admin page in the app
--    can list every user's referral_source, not just their own).
--
--    IMPORTANT: a policy on `profiles` cannot subquery `profiles` directly —
--    Postgres detects that as infinite recursion and every read/write on the
--    table starts failing ("fetch failed" in the app when saving settings).
--    A SECURITY DEFINER function breaks the recursion because it bypasses RLS
--    internally.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select to authenticated
  using (
    auth.uid() = id
    or public.is_admin(auth.uid())
  );

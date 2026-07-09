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

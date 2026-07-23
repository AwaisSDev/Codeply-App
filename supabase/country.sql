-- ============================================================
--  Codeply — "Which country are you from" onboarding field
--  Run this in Supabase → SQL Editor (one time).
-- ============================================================

-- Column on profiles to hold the answer. RLS policies for a signed-in user
-- updating their own row ("profiles_update_own") and an admin reading every
-- row ("profiles_select_own_or_admin") already exist from referral_source.sql
-- — no new policies needed here.
alter table public.profiles
  add column if not exists country text;

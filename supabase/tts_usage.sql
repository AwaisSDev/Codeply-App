-- Daily character budget for bot voices (the tts-proxy edge function).
-- Deepgram bills per character, so each user gets a daily allowance; the
-- function adds to it with add_tts_chars() before every sentence it speaks.
-- Only the service role touches this table (RLS on, no policies).

create table if not exists public.tts_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  chars integer not null default 0,
  primary key (user_id, day)
);

alter table public.tts_usage enable row level security;

-- Adds p_chars to today's total and returns the new total, atomically.
create or replace function public.add_tts_chars(p_user uuid, p_chars integer)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.tts_usage (user_id, day, chars)
  values (p_user, (now() at time zone 'utc')::date, greatest(p_chars, 0))
  on conflict (user_id, day) do update set chars = public.tts_usage.chars + excluded.chars
  returning chars;
$$;

revoke all on function public.add_tts_chars(uuid, integer) from public, anon, authenticated;
grant execute on function public.add_tts_chars(uuid, integer) to service_role;

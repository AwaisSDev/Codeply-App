-- ============================================================
--  Codeply — Groq API key rotation state
--  Run this in Supabase → SQL Editor (one time).
--
--  The ai-proxy edge function can be configured with several Groq API keys
--  (GROQ_API_KEYS, comma-separated) instead of just one, to pool multiple
--  free-tier quotas together. This table remembers which key currently
--  works ("the sticky default") so every new request doesn't have to
--  re-discover an already-exhausted key from scratch — it starts at the
--  last one that succeeded, and only rotates further if THAT one also
--  fails. updated_on resets it back to key 0 each day, since Groq's daily
--  quotas refresh at midnight UTC and an exhausted key from yesterday is
--  fresh again today.
--
--  Only the edge function (via the service-role key, which bypasses RLS)
--  ever touches this table — it's internal bookkeeping, not user data.
-- ============================================================

create table if not exists public.proxy_key_state (
  id             integer primary key default 1,
  current_index  integer not null default 0,
  updated_on     date not null default (now() at time zone 'utc')::date,
  constraint proxy_key_state_singleton check (id = 1)
);

insert into public.proxy_key_state (id, current_index, updated_on)
values (1, 0, (now() at time zone 'utc')::date)
on conflict (id) do nothing;

-- RLS enabled with NO policies for anon/authenticated — only service_role
-- (which bypasses RLS entirely) can read or write this table.
alter table public.proxy_key_state enable row level security;

-- Always-on bots in Codeply Cloud: keep watching the user's Gmail while their
-- PC is off (Craft's bots-watch.js hands off with a heartbeat).
--
-- mail-watch (the user's token) stores the Gmail sign-in and the watching
-- bots; mail-watch-tick (pg_cron, see mail_watch_cron.sql) polls with no
-- model calls and only acts on important mail. The Gmail refresh token is
-- kept with envelope encryption (AES-256-GCM, a random key per row wrapped
-- with a key derived by HKDF from MAIL_WATCH_MASTER_SECRET), so the database
-- alone never reveals it.
--
-- Clients can never read these tables: RLS is on with no policies, and the
-- anon and authenticated roles have no grants. Only the edge functions (the
-- service role) touch them.

create table if not exists public.mail_watch_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  token_enc text not null,                 -- sealed { refreshToken, clientId, clientSecret }
  enabled boolean not null default true,
  desktop_seen_at timestamptz,             -- the PC's last heartbeat; the cloud waits while it is fresh
  desktop_cursor text,                     -- Gmail historyId the PC has handled up to
  cloud_cursor text,                       -- historyId the cloud has handled up to
  last_check timestamptz,
  next_check_at timestamptz not null default now(),
  failures integer not null default 0,
  last_error text,
  senders jsonb not null default '{}'::jsonb, -- { address: true|false } has the user emailed them (capped)
  updated_at timestamptz not null default now()
);
create index if not exists mail_watch_accounts_due_idx on public.mail_watch_accounts (next_check_at) where enabled;

create table if not exists public.mail_watch_bots (
  user_id uuid not null references auth.users (id) on delete cascade,
  bot_id text not null,
  name text not null,
  voice text,
  specialty text not null default '',
  instructions text not null default '',
  tone text not null default '',
  memory jsonb not null default '[]'::jsonb,
  keywords jsonb not null default '[]'::jsonb,
  senders jsonb not null default '[]'::jsonb,
  reach text not null default 'push' check (reach in ('message', 'push', 'call')),
  draft boolean not null default true,
  quiet jsonb not null default '{"on": true, "from": "22:00", "to": "07:00"}'::jsonb,
  tz text,
  primary key (user_id, bot_id)
);

-- Every message id either side handled: inserting first is how a message is claimed, once.
create table if not exists public.mail_watch_seen (
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id text not null,
  at timestamptz not null default now(),
  primary key (user_id, message_id)
);
create index if not exists mail_watch_seen_at_idx on public.mail_watch_seen (user_id, at desc);

-- What the cloud did, so Craft can show it in the bots' threads when the PC is back.
create table if not exists public.mail_watch_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  bot_id text not null,
  data jsonb not null,
  at timestamptz not null default now()
);
create index if not exists mail_watch_events_user_idx on public.mail_watch_events (user_id, at);

alter table public.mail_watch_accounts enable row level security;
alter table public.mail_watch_bots enable row level security;
alter table public.mail_watch_seen enable row level security;
alter table public.mail_watch_events enable row level security;
revoke all on public.mail_watch_accounts, public.mail_watch_bots, public.mail_watch_seen, public.mail_watch_events from anon, authenticated;
revoke all on sequence public.mail_watch_events_id_seq from anon, authenticated;

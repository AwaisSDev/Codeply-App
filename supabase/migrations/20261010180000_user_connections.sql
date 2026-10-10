-- Connected apps (Gmail, Slack, Vercel, Supabase, GitHub) for Codeply Cloud runs.
-- A cloud run happens on GitHub's servers, which don't have the sign-ins saved
-- on the user's PC, so Craft keeps a copy here for the signed-in user and the
-- run fetches it at start (with the user's usage key, see track_keys).
-- `data` is AES-GCM encrypted by the connections function with a server-only
-- key (CONNECTIONS_KEY); the database never sees a token in the clear.
-- Service role only: RLS on, no policies, no grants.
create table if not exists public.user_connections (
  user_id    uuid not null references auth.users (id) on delete cascade,
  provider   text not null,
  data       text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.user_connections enable row level security;
revoke all on public.user_connections from anon, authenticated;

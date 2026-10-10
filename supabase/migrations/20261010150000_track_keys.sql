-- Usage keys for Codeply Cloud runs. A cloud run happens inside GitHub Actions
-- with no Codeply sign-in, so Craft creates one of these keys for the signed-in
-- user and puts it in the repo's encrypted secrets (CODEPLY_TRACK_KEY). The
-- runner sends usage counts with it, and the track function maps it back to the
-- user. Only a SHA-256 of the key is stored. Service role only (no policies).
create table if not exists public.track_keys (
  key_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists track_keys_user_idx on public.track_keys (user_id);
alter table public.track_keys enable row level security;
revoke all on public.track_keys from anon, authenticated;

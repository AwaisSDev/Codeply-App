-- Gmail for the bots on phone calls (functions/_shared/gmail-lookup.ts), so
-- they can read the inbox while the user's PC is off. The user turns it on in
-- Craft ("Use Gmail from my phone"); mail-watch's link / unlink actions write
-- here. The Gmail sign-in is sealed exactly like mail_watch_accounts
-- (_shared/mail-crypto.ts). Kept apart from the watcher, so switching watching
-- off never removes it.
--
-- Clients can never read it: RLS on, no policies, no grants. Only the edge
-- functions (the service role) touch it.
create table if not exists public.mail_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  token_enc text not null,
  updated_at timestamptz not null default now()
);
alter table public.mail_links enable row level security;
revoke all on public.mail_links from anon, authenticated;

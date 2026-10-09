-- Which Codeply apps people use, and how much AI they burn: one row per AI
-- call (or app session), sent by Craft, Crew and the CLI through the track
-- function. Counts only: which app, which model, Auto or the user's own key,
-- tokens in and out, app version and platform. Never prompts or replies.
--
-- Clients can never read or write it directly: RLS on, no policies, no grants.
-- The track function (service role) writes; the admin dashboard reads.
create table if not exists public.app_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users (id) on delete cascade,
  product     text not null,            -- craft | crew | cli | drop | phone
  kind        text not null default 'ai', -- ai (one model call) | open (app opened)
  model       text,
  provider    text,                     -- auto | byok | proxy | ollama | chatgpt
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  ms          integer,
  version     text,
  platform    text,
  created_at  timestamptz not null default now()
);
create index if not exists app_events_created_idx on public.app_events (created_at desc);
create index if not exists app_events_product_created_idx on public.app_events (product, created_at desc);
create index if not exists app_events_user_created_idx on public.app_events (user_id, created_at desc);
alter table public.app_events enable row level security;
revoke all on public.app_events from anon, authenticated;

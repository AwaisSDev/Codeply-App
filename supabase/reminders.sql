-- Reminders from the user's bots (the Codeply phone app).
--
-- A bot sets a reminder on a call or in a chat ("call me at 7", "plan my
-- day"); reminders-tick (every minute, pg_cron + pg_net, see
-- reminders_cron.sql) sends a Web Push to the user's phones when it is due.
-- Tapping it opens the app on an incoming call from that bot.
--
-- The edge functions (reminders, push-subscribe, reminders-tick) use the
-- service role after checking the user's token; RLS still keeps every row to
-- its owner for anything that reads these tables directly.

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bot_id text,
  bot_name text not null default 'Codeply',
  bot_voice text,
  text text not null check (char_length(text) between 1 and 500),
  due_at timestamptz not null,
  tz text,                                   -- the phone's IANA time zone, for repeats
  repeat text check (repeat in ('daily', 'weekdays', 'weekly')),
  kind text not null default 'remind' check (kind in ('remind', 'call', 'task')),
  payload jsonb not null default '{}'::jsonb, -- e.g. a prepared message, or the task for the bot
  status text not null default 'pending' check (status in ('pending', 'sent', 'done', 'snoozed')),
  action_key text not null default encode(extensions.gen_random_bytes(16), 'hex'), -- lets the notification's Snooze work without a sign-in
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reminders_due_idx on public.reminders (due_at) where status in ('pending', 'snoozed');
create index if not exists reminders_user_idx on public.reminders (user_id, due_at);

alter table public.reminders enable row level security;

drop policy if exists "reminders: own rows" on public.reminders;
create policy "reminders: own rows" on public.reminders
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,          -- { p256dh, auth }
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions: own rows" on public.push_subscriptions;
create policy "push_subscriptions: own rows" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

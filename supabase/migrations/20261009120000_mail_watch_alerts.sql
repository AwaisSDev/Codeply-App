-- "Call / text me when X emails me" (a bot's watch_email alerts), so the cloud
-- watcher honours them while the user's PC is off. A list of
-- { from, how: 'call' | 'text', repeat }.
alter table public.mail_watch_bots add column if not exists alerts jsonb not null default '[]'::jsonb;

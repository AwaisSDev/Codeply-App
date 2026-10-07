-- Runs mail-watch-tick every 2 minutes (pg_cron + pg_net, the same pattern as
-- reminders_cron.sql, with the URL and the secret read from Vault).
--
-- Before running this once (project_url is already there for reminders):
--   select vault.create_secret('<MAIL_WATCH_CRON_SECRET>', 'mail_watch_cron_secret');
-- and `supabase secrets set MAIL_WATCH_CRON_SECRET=...` with the same value.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'mail-watch-tick') then
    perform cron.unschedule('mail-watch-tick');
  end if;
end $$;

select cron.schedule(
  'mail-watch-tick',
  '*/2 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/mail-watch-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_watch_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $job$
);

-- Old seen ids and events are not needed after a month.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'mail-watch-cleanup') then
    perform cron.unschedule('mail-watch-cleanup');
  end if;
end $$;

select cron.schedule(
  'mail-watch-cleanup',
  '17 3 * * *',
  $job$
  delete from public.mail_watch_seen where at < now() - interval '30 days';
  delete from public.mail_watch_events where at < now() - interval '30 days';
  $job$
);

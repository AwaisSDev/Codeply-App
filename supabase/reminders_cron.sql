-- Runs the reminders-tick edge function every minute (Supabase's recommended
-- pattern: pg_cron + pg_net, with the URL and the secret read from Vault, never
-- written into the job itself).
--
-- Before running this once, store the two values in Vault (the secret is the
-- same random string as the function secret REMINDERS_CRON_SECRET):
--   select vault.create_secret('https://zswkhfkfseclgadhvobg.supabase.co', 'project_url');
--   select vault.create_secret('<REMINDERS_CRON_SECRET>', 'reminders_cron_secret');
-- (To change the secret later: vault.update_secret(id, new_value) and
-- `supabase secrets set REMINDERS_CRON_SECRET=...`.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'reminders-tick') then
    perform cron.unschedule('reminders-tick');
  end if;
end $$;

select cron.schedule(
  'reminders-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/reminders-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) as request_id;
  $job$
);

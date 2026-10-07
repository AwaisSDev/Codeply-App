-- ============================================================
--  Codeply: models synced from Craft to the phone (user_models)
--  Apply with `supabase db push`, or run it once in the SQL Editor.
--
--  A model the user adds in Codeply Craft with their own API key can be
--  synced here so the phone can use it while the PC is off. Two tables:
--
--    public.user_models          metadata only (name, base URL, model id,
--                                last four characters of the key). The owner
--                                can read their own rows.
--    public.user_model_secrets   the envelope-encrypted key (see
--                                functions/_shared/model-keys.ts). No grants
--                                and no policies for anon/authenticated, so
--                                only the service role (the user-models and
--                                byok-proxy edge functions) can ever touch it.
--
--  The plaintext key never reaches the database: the edge function encrypts
--  it with a per-row data key, wrapped by a KEK derived from MODEL_KEYS_KEK,
--  which only exists in the functions' environment.
-- ============================================================

-- 1) Metadata, readable by its owner.
create table if not exists public.user_models (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id    text not null,                       -- the model's id in Craft (~/.codeply/config.json)
  name         text not null,
  kind         text not null default 'openai',
  base_url     text not null,
  model        text not null,
  key_last4    text not null default '',
  key_version  integer not null default 0,          -- bumps every time a new key is saved
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint user_models_client_unique unique (user_id, client_id),
  constraint user_models_kind_check check (kind in ('openai')),
  constraint user_models_client_id_check check (client_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint user_models_name_check check (char_length(name) between 1 and 80),
  constraint user_models_model_check check (char_length(model) between 1 and 200),
  constraint user_models_base_url_check check (base_url ~ '^https://' and char_length(base_url) <= 500),
  constraint user_models_last4_check check (key_last4 ~ '^[ -~]{0,4}$')
);

create index if not exists user_models_user_idx on public.user_models (user_id, updated_at desc);

alter table public.user_models enable row level security;

drop policy if exists "user_models_select_own" on public.user_models;
create policy "user_models_select_own" on public.user_models
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "user_models_insert_own" on public.user_models;
create policy "user_models_insert_own" on public.user_models
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "user_models_update_own" on public.user_models;
create policy "user_models_update_own" on public.user_models
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_models_delete_own" on public.user_models;
create policy "user_models_delete_own" on public.user_models
  for delete to authenticated using (auth.uid() = user_id);

-- Column privileges are checked before RLS. A client may rename its own model
-- or delete it, but key_last4 / key_version are only ever written by the edge
-- function, and base_url is also bound into the key's encryption (changing it
-- outside the function just makes the key undecryptable, never redirects it).
revoke all on public.user_models from anon, authenticated;
grant select (id, user_id, client_id, name, kind, base_url, model, key_last4, key_version, created_at, updated_at)
  on public.user_models to authenticated;
grant insert (client_id, name, kind, base_url, model) on public.user_models to authenticated;
grant update (name) on public.user_models to authenticated;
grant delete on public.user_models to authenticated;

-- 2) Ciphertext, service role only.
create table if not exists public.user_model_secrets (
  model_id        uuid primary key references public.user_models(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  kek_version     integer not null check (kek_version >= 1),
  dek_iv          text not null,     -- base64, 12 bytes
  wrapped_dek     text not null,     -- base64, AES-256-GCM(KEK, data key), AAD bound
  key_iv          text not null,     -- base64, 12 bytes
  key_ciphertext  text not null,     -- base64, AES-256-GCM(data key, API key), AAD bound
  updated_at      timestamptz not null default now()
);

alter table public.user_model_secrets enable row level security;
-- RLS on with NO policies, and no table privileges either: belt and braces.
revoke all on public.user_model_secrets from public, anon, authenticated;

-- 3) Atomic save, called only by the user-models edge function (service role).
--    Writes the metadata and the sealed key in one transaction. The expected
--    key_version guards against two saves racing each other: the loser gets
--    'user_model_conflict' and simply retries.
create or replace function public.user_model_save(
  p_user_id uuid, p_id uuid, p_client_id text, p_name text, p_kind text, p_base_url text, p_model text,
  p_key_last4 text, p_key_version integer, p_expected_version integer, p_secret jsonb
) returns public.user_models
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.user_models;
begin
  insert into public.user_models as m (id, user_id, client_id, name, kind, base_url, model, key_last4, key_version)
  values (p_id, p_user_id, p_client_id, p_name, p_kind, p_base_url, p_model, p_key_last4, p_key_version)
  on conflict (user_id, client_id) do update
    set name = excluded.name, kind = excluded.kind, base_url = excluded.base_url, model = excluded.model,
        key_last4 = excluded.key_last4, key_version = excluded.key_version, updated_at = now()
    where m.id = excluded.id and m.key_version = p_expected_version
  returning * into r;
  if r.id is null then
    raise exception 'user_model_conflict' using errcode = '40001';
  end if;

  if p_secret is not null then
    insert into public.user_model_secrets (model_id, user_id, kek_version, dek_iv, wrapped_dek, key_iv, key_ciphertext, updated_at)
    values (r.id, p_user_id, (p_secret->>'kek_version')::integer, p_secret->>'dek_iv', p_secret->>'wrapped_dek',
            p_secret->>'key_iv', p_secret->>'key_ciphertext', now())
    on conflict (model_id) do update
      set kek_version = excluded.kek_version, dek_iv = excluded.dek_iv, wrapped_dek = excluded.wrapped_dek,
          key_iv = excluded.key_iv, key_ciphertext = excluded.key_ciphertext, updated_at = now();
  elsif not exists (select 1 from public.user_model_secrets s where s.model_id = r.id) then
    raise exception 'user_model_no_key' using errcode = '22023';
  end if;
  return r;
end;
$$;

revoke all on function public.user_model_save(uuid, uuid, text, text, text, text, text, text, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.user_model_save(uuid, uuid, text, text, text, text, text, text, integer, integer, jsonb) to service_role;

-- 4) Rate limiting for both functions: a sliding window per user and action.
create table if not exists public.user_model_requests (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  action      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists user_model_requests_idx on public.user_model_requests (user_id, action, created_at desc);
alter table public.user_model_requests enable row level security;
revoke all on public.user_model_requests from public, anon, authenticated;

-- Records one request and says whether it is within the limit. auth.uid()
-- inside, so a caller can only ever spend their own budget.
create or replace function public.user_models_hit(p_action text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  used integer;
begin
  if uid is null then return false; end if;
  if p_action !~ '^[a-z_]{1,24}$' or p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then return false; end if;
  -- One caller at a time per user and action, so a burst cannot slip past the count.
  perform pg_advisory_xact_lock(hashtext(uid::text || ':' || p_action));
  select count(*) into used from public.user_model_requests
   where user_id = uid and action = p_action and created_at > now() - make_interval(secs => p_window_seconds);
  if used >= p_limit then return false; end if;
  insert into public.user_model_requests (user_id, action) values (uid, p_action);
  return true;
end;
$$;

revoke all on function public.user_models_hit(text, integer, integer) from public, anon;
grant execute on function public.user_models_hit(text, integer, integer) to authenticated;

-- 5) (Optional) house-keeping: only the last day is ever needed for the limits.
-- delete from public.user_model_requests where created_at < now() - interval '2 days';

// Codeply: envelope encryption for the API keys of models synced from Craft.
//
// Every saved key gets its own random 256-bit data key (DEK). The API key is
// sealed with that DEK using AES-256-GCM and a fresh random 96-bit IV. The DEK
// itself is then sealed ("wrapped") with a key-encryption key (KEK) that is
// derived with HKDF-SHA256 from a server secret that only exists in the edge
// function's environment (MODEL_KEYS_KEK). The database therefore only ever
// holds ciphertext: a copy of the tables alone decrypts nothing.
//
// Both seals carry additional authenticated data (AAD) binding the ciphertext
// to its owner, its row, its key version and the base URL it was saved for.
// Moving a ciphertext to another user's row, another model, an older version
// or a different address makes decryption fail instead of leaking the key.
//
// MODEL_KEYS_KEK holds one or more versioned secrets, "v1:<base64>,v2:<base64>".
// The highest version wraps new keys; older versions stay listed only until
// every row has been re-wrapped (see rewrapKey and the byok-proxy function).
// Each secret must decode to at least 32 random bytes:
//   openssl rand -base64 32
//
// Plain WebCrypto only, no Deno APIs, so it runs (and is tested) in Deno and
// in Node 22+ alike. See supabase/tests/model-keys.test.mjs.

const enc = new TextEncoder();
const dec = new TextDecoder();

const HKDF_SALT = enc.encode("codeply/user_models/kek-salt/v1");
const AAD_LABEL = "codeply.user_models.v1";

export type KekRing = { current: number; secrets: Map<number, Uint8Array> };

/** What gets stored in public.user_model_secrets (all binary as base64). */
export type SealedKey = {
  kek_version: number;
  dek_iv: string;
  wrapped_dek: string;
  key_iv: string;
  key_ciphertext: string;
};

export type KeyContext = {
  userId: string;
  modelId: string;
  keyVersion: number;
  baseUrl: string;
};

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(String(s || "")), (c) => c.charCodeAt(0));
}

/** Parses MODEL_KEYS_KEK. Throws on anything weak or malformed, so a bad deploy fails loudly. */
export function parseKekRing(spec: string): KekRing {
  const secrets = new Map<number, Uint8Array>();
  for (const part of String(spec || "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^v(\d{1,4}):([A-Za-z0-9+/=_-]+)$/.exec(part);
    if (!m) throw new Error("MODEL_KEYS_KEK entries must look like v1:<base64>");
    const version = Number(m[1]);
    if (version < 1) throw new Error("MODEL_KEYS_KEK versions start at 1");
    if (secrets.has(version)) throw new Error(`MODEL_KEYS_KEK lists v${version} twice`);
    let bytes: Uint8Array;
    try { bytes = fromB64(m[2].replace(/-/g, "+").replace(/_/g, "/")); } catch { throw new Error(`MODEL_KEYS_KEK v${version} is not valid base64`); }
    if (bytes.length < 32) throw new Error(`MODEL_KEYS_KEK v${version} must be at least 32 random bytes`);
    secrets.set(version, bytes);
  }
  if (!secrets.size) throw new Error("MODEL_KEYS_KEK is not set");
  return { current: Math.max(...secrets.keys()), secrets };
}

/** The AAD both seals use: an unambiguous encoding of who, which row, which version, which address. */
export function keyAad(ctx: KeyContext, purpose: "key" | "dek"): Uint8Array {
  if (!ctx.userId || !ctx.modelId || !Number.isInteger(ctx.keyVersion) || ctx.keyVersion < 1 || !ctx.baseUrl) {
    throw new Error("Incomplete key context");
  }
  return enc.encode(JSON.stringify([AAD_LABEL, purpose, ctx.userId, ctx.modelId, ctx.keyVersion, ctx.baseUrl]));
}

async function kek(ring: KekRing, version: number): Promise<CryptoKey> {
  const secret = ring.secrets.get(version);
  if (!secret) throw new Error("Key unavailable");
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: enc.encode(`codeply/user_models/kek/v${version}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function gcmSeal(rawKey: Uint8Array | CryptoKey, data: Uint8Array, aad: Uint8Array) {
  const key = rawKey instanceof Uint8Array
    ? await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"])
    : rawKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, data));
  return { iv, ct };
}

async function gcmOpen(rawKey: Uint8Array | CryptoKey, iv: Uint8Array, ct: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (iv.length !== 12) throw new Error("Key unavailable");
  const key = rawKey instanceof Uint8Array
    ? await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"])
    : rawKey;
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ct));
}

/** Seals an API key under a brand-new data key, wrapped with the current KEK. */
export async function sealKey(ring: KekRing, ctx: KeyContext, apiKey: string): Promise<SealedKey> {
  if (!apiKey) throw new Error("Empty key");
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const plain = enc.encode(apiKey);
  try {
    const sealedKey = await gcmSeal(dek, plain, keyAad(ctx, "key"));
    const wrapped = await gcmSeal(await kek(ring, ring.current), dek, keyAad(ctx, "dek"));
    return {
      kek_version: ring.current,
      dek_iv: toB64(wrapped.iv),
      wrapped_dek: toB64(wrapped.ct),
      key_iv: toB64(sealedKey.iv),
      key_ciphertext: toB64(sealedKey.ct),
    };
  } finally {
    dek.fill(0);
    plain.fill(0);
  }
}

async function unwrapDek(ring: KekRing, ctx: KeyContext, sealed: SealedKey): Promise<Uint8Array> {
  try {
    return await gcmOpen(await kek(ring, sealed.kek_version), fromB64(sealed.dek_iv), fromB64(sealed.wrapped_dek), keyAad(ctx, "dek"));
  } catch {
    // One generic error for every failure: wrong user, wrong row, tampering, retired KEK.
    throw new Error("Key unavailable");
  }
}

/** Opens a sealed key. Throws "Key unavailable" on any mismatch or tampering. */
export async function openKey(ring: KekRing, ctx: KeyContext, sealed: SealedKey): Promise<string> {
  const dek = await unwrapDek(ring, ctx, sealed);
  try {
    const plain = await gcmOpen(dek, fromB64(sealed.key_iv), fromB64(sealed.key_ciphertext), keyAad(ctx, "key"));
    const text = dec.decode(plain);
    plain.fill(0);
    return text;
  } catch {
    throw new Error("Key unavailable");
  } finally {
    dek.fill(0);
  }
}

/** True when a row was wrapped with an older KEK and should be re-wrapped. */
export function needsRewrap(ring: KekRing, sealed: SealedKey): boolean {
  return sealed.kek_version !== ring.current;
}

/**
 * Re-wraps the data key with the current KEK (rotation). The API key's own
 * ciphertext is untouched, and the plaintext key is never produced.
 */
export async function rewrapKey(ring: KekRing, ctx: KeyContext, sealed: SealedKey): Promise<SealedKey> {
  const dek = await unwrapDek(ring, ctx, sealed);
  try {
    const wrapped = await gcmSeal(await kek(ring, ring.current), dek, keyAad(ctx, "dek"));
    return { ...sealed, kek_version: ring.current, dek_iv: toB64(wrapped.iv), wrapped_dek: toB64(wrapped.ct) };
  } finally {
    dek.fill(0);
  }
}

/** The only part of a key that is ever shown again: its last four characters. */
export function keyLast4(apiKey: string): string {
  const k = String(apiKey || "");
  return k.length >= 12 ? k.slice(-4) : "";
}

export function maskedKey(last4: string): string {
  return last4 ? `****${last4}` : "****";
}

/** Removes every occurrence of the key from a provider's error text before it goes anywhere. */
export function scrubKey(text: string, apiKey: string): string {
  let s = String(text || "");
  if (apiKey && apiKey.length >= 4) s = s.split(apiKey).join("[key]");
  return s.replace(/\b(sk|rk|pk|gsk|xai|AIza)[-_A-Za-z0-9]{12,}/g, "[key]");
}

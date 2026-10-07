// Envelope encryption for the Gmail sign-ins always-on bots use in the cloud.
//
// Each sealed value gets its own random 256-bit data key (AES-256-GCM). The
// data key is wrapped with a key-encryption key derived by HKDF-SHA256 from
// MAIL_WATCH_MASTER_SECRET, a random salt per value and the user's id, so a
// row copied to another user does not open. The user id is also the AAD of
// both layers. Nothing is sliced or padded: a short secret is refused.
//
// Sealed format: "mw1." + base64url(JSON { s: salt, wi: wrap iv, wk: wrapped key, i: iv, c: ciphertext }).

const enc = new TextEncoder();
const dec = new TextDecoder();
const MIN_SECRET = 32;

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function masterSecret(): string {
  const s = Deno.env.get("MAIL_WATCH_MASTER_SECRET") ?? "";
  if (s.length < MIN_SECRET) throw new Error("MAIL_WATCH_MASTER_SECRET is missing or shorter than 32 characters.");
  return s;
}

async function keyEncryptionKey(salt: Uint8Array, userId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(masterSecret()), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`codeply mail-watch kek v1 ${userId}`) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function seal(plain: string, userId: string): Promise<string> {
  const aad = enc.encode(userId);
  const salt = random(16);
  const dataKeyRaw = random(32);
  const dataKey = await crypto.subtle.importKey("raw", dataKeyRaw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = random(12);
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, dataKey, enc.encode(plain)));
  const wi = random(12);
  const wk = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wi, additionalData: aad }, await keyEncryptionKey(salt, userId), dataKeyRaw));
  dataKeyRaw.fill(0);
  return "mw1." + b64u(enc.encode(JSON.stringify({ s: b64u(salt), wi: b64u(wi), wk: b64u(wk), i: b64u(iv), c: b64u(c) })));
}

export async function open(sealed: string, userId: string): Promise<string> {
  if (!sealed.startsWith("mw1.")) throw new Error("Unknown sealed format.");
  const o = JSON.parse(dec.decode(unb64u(sealed.slice(4))));
  const aad = enc.encode(userId);
  const kek = await keyEncryptionKey(unb64u(o.s), userId);
  const dataKeyRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(o.wi), additionalData: aad }, kek, unb64u(o.wk)));
  const dataKey = await crypto.subtle.importKey("raw", dataKeyRaw, { name: "AES-GCM" }, false, ["decrypt"]);
  dataKeyRaw.fill(0);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(o.i), additionalData: aad }, dataKey, unb64u(o.c)));
}

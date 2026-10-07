// Offline tests for the synced-model key crypto and the base URL guard.
//
//   node supabase/tests/model-keys.test.mjs      (Node 22.18+ or 23.6+ strips the TS types itself)
//   deno run supabase/tests/model-keys.test.mjs
//
// No network, no database, no real keys: every secret here is random or a
// placeholder made up for the test.
import {
  parseKekRing, sealKey, openKey, rewrapKey, needsRewrap, keyAad, keyLast4, maskedKey, scrubKey, toB64,
} from '../functions/_shared/model-keys.ts';
import { checkBaseUrl, checkResolvedHost, isPrivateIp } from '../functions/_shared/url-guard.ts';

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; console.log(`PASS  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}`); }
}
async function rejects(promiseFn) {
  try { await promiseFn(); return false; } catch { return true; }
}

const randSecret = () => toB64(crypto.getRandomValues(new Uint8Array(32)));
const S1 = randSecret();
const S2 = randSecret();
const ring1 = parseKekRing(`v1:${S1}`);
const ring12 = parseKekRing(`v1:${S1},v2:${S2}`);
const ring2only = parseKekRing(`v2:${S2}`);
const ringOther = parseKekRing(`v1:${randSecret()}`);

const FAKE_KEY = 'test-key-' + toB64(crypto.getRandomValues(new Uint8Array(18))).replace(/[^A-Za-z0-9]/g, 'x');
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const MODEL_1 = '11111111-1111-4111-8111-111111111111';
const MODEL_2 = '22222222-2222-4222-8222-222222222222';
const ctx = { userId: USER_A, modelId: MODEL_1, keyVersion: 1, baseUrl: 'https://api.example.com/v1' };

// ── KEK ring parsing ─────────────────────────────────────────────────────────
check('ring: highest version is current', ring12.current === 2);
check('ring: empty spec is refused', await rejects(async () => parseKekRing('')));
check('ring: short secret is refused', await rejects(async () => parseKekRing(`v1:${toB64(new Uint8Array(16))}`)));
check('ring: malformed entry is refused', await rejects(async () => parseKekRing('one:abc')));
check('ring: duplicate version is refused', await rejects(async () => parseKekRing(`v1:${S1},v1:${S2}`)));

// ── Round trip ───────────────────────────────────────────────────────────────
const sealed = await sealKey(ring1, ctx, FAKE_KEY);
check('seal: records the KEK version', sealed.kek_version === 1);
check('seal: 96-bit IVs', atob(sealed.key_iv).length === 12 && atob(sealed.dek_iv).length === 12);
check('seal: wrapped data key is 32 bytes + 16-byte tag', atob(sealed.wrapped_dek).length === 48);
check('seal: ciphertext does not contain the key', !JSON.stringify(sealed).includes(FAKE_KEY) && !atob(sealed.key_ciphertext).includes(FAKE_KEY));
check('round trip: opens to the same key', (await openKey(ring1, ctx, sealed)) === FAKE_KEY);

const sealedAgain = await sealKey(ring1, ctx, FAKE_KEY);
check('seal: a fresh data key and IV every time', sealedAgain.key_ciphertext !== sealed.key_ciphertext && sealedAgain.wrapped_dek !== sealed.wrapped_dek && sealedAgain.key_iv !== sealed.key_iv);

// ── Tamper detection (AAD binds owner, row, version, address) ───────────────
check('tamper: wrong user cannot open', await rejects(() => openKey(ring1, { ...ctx, userId: USER_B }, sealed)));
check('tamper: another model row cannot open', await rejects(() => openKey(ring1, { ...ctx, modelId: MODEL_2 }, sealed)));
check('tamper: a different key version cannot open', await rejects(() => openKey(ring1, { ...ctx, keyVersion: 2 }, sealed)));
check('tamper: a different base URL cannot open', await rejects(() => openKey(ring1, { ...ctx, baseUrl: 'https://evil.example.net/v1' }, sealed)));
check('tamper: a different KEK cannot open', await rejects(() => openKey(ringOther, ctx, sealed)));
const flip = (b64) => { const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); b[0] ^= 1; return toB64(b); };
check('tamper: flipped ciphertext bit is caught', await rejects(() => openKey(ring1, ctx, { ...sealed, key_ciphertext: flip(sealed.key_ciphertext) })));
check('tamper: flipped wrapped key bit is caught', await rejects(() => openKey(ring1, ctx, { ...sealed, wrapped_dek: flip(sealed.wrapped_dek) })));
check('tamper: flipped IV bit is caught', await rejects(() => openKey(ring1, ctx, { ...sealed, key_iv: flip(sealed.key_iv) })));
const other = await sealKey(ring1, { ...ctx, modelId: MODEL_2 }, 'another-test-key-0000');
check('tamper: swapping wrapped keys between rows is caught', await rejects(() => openKey(ring1, ctx, { ...sealed, wrapped_dek: other.wrapped_dek, dek_iv: other.dek_iv })));
let genericError = '';
try { await openKey(ring1, { ...ctx, userId: USER_B }, sealed); } catch (e) { genericError = e.message; }
check('tamper: failure message is generic', genericError === 'Key unavailable');
check('aad: incomplete context is refused', await rejects(async () => keyAad({ ...ctx, keyVersion: 0 }, 'key')));

// ── KEK rotation ─────────────────────────────────────────────────────────────
check('rotation: old row opens while v1 is still listed', (await openKey(ring12, ctx, sealed)) === FAKE_KEY);
check('rotation: old row is flagged for re-wrap', needsRewrap(ring12, sealed) && !needsRewrap(ring1, sealed));
const rewrapped = await rewrapKey(ring12, ctx, sealed);
check('rotation: re-wrap moves to the current KEK', rewrapped.kek_version === 2);
check('rotation: re-wrap leaves the key ciphertext alone', rewrapped.key_ciphertext === sealed.key_ciphertext && rewrapped.key_iv === sealed.key_iv);
check('rotation: re-wrapped row opens with only v2 listed', (await openKey(ring2only, ctx, rewrapped)) === FAKE_KEY);
check('rotation: un-rewrapped row fails once v1 is retired', await rejects(() => openKey(ring2only, ctx, sealed)));
check('rotation: new keys use the newest KEK', (await sealKey(ring12, ctx, FAKE_KEY)).kek_version === 2);
check('rotation: re-wrap still checks the AAD', await rejects(() => rewrapKey(ring12, { ...ctx, userId: USER_B }, sealed)));

// ── Display helpers ──────────────────────────────────────────────────────────
check('mask: only the last four are kept', keyLast4(FAKE_KEY) === FAKE_KEY.slice(-4) && maskedKey(keyLast4(FAKE_KEY)) === `****${FAKE_KEY.slice(-4)}`);
check('mask: short keys show nothing', keyLast4('short') === '' && maskedKey('') === '****');
check('scrub: the key is removed from provider errors', !scrubKey(`Incorrect API key provided: ${FAKE_KEY}.`, FAKE_KEY).includes(FAKE_KEY));
check('scrub: key-shaped strings are removed too', !scrubKey('bad key sk-abcdefghijklmnopqrstuv', '').includes('abcdefghijklmnop'));

// ── Base URL guard (SSRF) ────────────────────────────────────────────────────
const ok = (u) => checkBaseUrl(u).ok === true;
check('url: public https is allowed', ok('https://api.openai.com/v1'));
check('url: trailing slash is normalized', checkBaseUrl('https://api.openai.com/v1/').url === 'https://api.openai.com/v1');
check('url: http is refused', !ok('http://api.openai.com/v1'));
check('url: credentials in the URL are refused', !ok('https://user:pass@api.example.com/v1'));
check('url: non-443 ports are refused', !ok('https://api.example.com:8080/v1'));
check('url: localhost is refused', !ok('https://localhost/v1') && !ok('https://foo.localhost/v1'));
check('url: loopback IPv4 is refused', !ok('https://127.0.0.1/v1') && !ok('https://127.1.2.3/v1'));
check('url: decimal and hex IPv4 forms are refused', !ok('https://2130706433/v1') && !ok('https://0x7f000001/v1'));
check('url: private IPv4 ranges are refused', !ok('https://10.0.0.5/v1') && !ok('https://172.16.0.1/v1') && !ok('https://192.168.1.1/v1') && !ok('https://100.64.0.1/v1'));
check('url: cloud metadata is refused', !ok('https://169.254.169.254/latest') && !ok('https://metadata.google.internal/v1'));
check('url: IPv6 loopback and private are refused', !ok('https://[::1]/v1') && !ok('https://[fd00::1]/v1') && !ok('https://[fe80::1]/v1'));
check('url: IPv4-mapped IPv6 loopback is refused', !ok('https://[::ffff:127.0.0.1]/v1') && isPrivateIp('::ffff:7f00:1') === true);
check('url: internal suffixes and bare names are refused', !ok('https://router.lan/v1') && !ok('https://intranet/v1') && !ok('https://svc.internal/v1'));
check('url: public IPs pass the literal check', ok('https://8.8.8.8/v1') && isPrivateIp('2606:4700::1111') === false);

const fakeDns = (map) => async (host, type) => { const r = (map[host] || {})[type]; if (!r) { const e = new Error('no record'); e.name = 'NotFound'; throw e; } return r; };
check('dns: a public name resolving to public addresses passes',
  (await checkResolvedHost('api.example.com', fakeDns({ 'api.example.com': { A: ['93.184.216.34'] } }))) === null);
check('dns: a public name resolving to a private address is refused',
  (await checkResolvedHost('sneaky.example.com', fakeDns({ 'sneaky.example.com': { A: ['93.184.216.34'], AAAA: ['::1'] } })))?.ok === false);
check('dns: a name that does not resolve is refused',
  (await checkResolvedHost('nothing.example.com', fakeDns({})))?.ok === false);
check('dns: a runtime without DNS skips the lookup', (await checkResolvedHost('api.example.com', null)) === null);

console.log(failures ? `\n${failures} FAILED` : `\nALL PASSED (${passes})`);
if (failures) (globalThis.process?.exit ?? globalThis.Deno?.exit)?.(1);

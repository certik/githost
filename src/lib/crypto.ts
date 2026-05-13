/**
 * AES-GCM helpers for encrypting user OAuth tokens at rest.
 *
 * Key is provided as a base64-encoded 32-byte value in `TOKEN_ENCRYPTION_KEY`.
 * Each encryption uses a fresh 12-byte IV stored alongside the ciphertext.
 */

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

// Cast helper: WebCrypto in @cloudflare/workers-types wants Uint8Array<ArrayBuffer>,
// but `new Uint8Array(n)` types as Uint8Array<ArrayBufferLike> on newer TS. Narrow it.
type Bytes = Uint8Array<ArrayBuffer>;

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be 32 bytes (got ${raw.length})`);
  }
  return crypto.subtle.importKey("raw", raw as Bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptString(keyB64: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Bytes;
  const data = new TextEncoder().encode(plaintext) as Bytes;
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { ciphertext: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

export async function decryptString(keyB64: string, ciphertextB64: string, ivB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = b64decode(ivB64) as Bytes;
  const ct = b64decode(ciphertextB64) as Bytes;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function randomId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64encode(b).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

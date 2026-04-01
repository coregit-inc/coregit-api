const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, CryptoKey>();

function decodeKeyBytes(secret: string): ArrayBuffer {
  try {
    const buf = Buffer.from(secret, "base64");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    throw new Error("SYNC_ENCRYPTION_KEY must be base64-encoded");
  }
}

async function resolveKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("SYNC_ENCRYPTION_KEY is not configured");
  if (keyCache.has(secret)) {
    return keyCache.get(secret)!;
  }
  const raw = decodeKeyBytes(secret);
  if (raw.byteLength !== 32) {
    throw new Error("SYNC_ENCRYPTION_KEY must decode to 32 bytes");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  keyCache.set(secret, cryptoKey);
  return cryptoKey;
}

function toBase64(data: ArrayBuffer | Uint8Array): string {
  return Buffer.from(data as ArrayBuffer).toString("base64");
}

function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

export async function encryptSecret(secretKey: string, plaintext: string): Promise<string> {
  const key = await resolveKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = encoder.encode(plaintext);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return `${toBase64(iv)}:${toBase64(cipher)}`;
}

export async function decryptSecret(secretKey: string, payload: string): Promise<string> {
  const key = await resolveKey(secretKey);
  const [ivB64, cipherB64] = payload.split(":");
  if (!ivB64 || !cipherB64) {
    throw new Error("Invalid encrypted payload");
  }
  const iv = fromBase64(ivB64);
  const cipher = fromBase64(cipherB64);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipher
  );
  return decoder.decode(plainBuffer);
}

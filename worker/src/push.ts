// Web Push sans dépendance : chiffrement RFC 8291 (aes128gcm) + authentification VAPID (RFC 8292).
// Fonctionne avec Chrome/Android (FCM), Firefox et Safari/iOS (Apple Push).

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function b64u(buf: ArrayBuffer | Bytes): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Bytes {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "===".slice((b.length + 3) % 4)), (c) => c.charCodeAt(0));
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

/** Chiffre `payload` pour un abonnement (clé p256dh 65 octets + secret auth 16 octets). */
export async function encryptPayload(payload: Bytes, p256dh: string, auth: string): Promise<Bytes> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(payload, new Uint8Array([2])); // délimiteur du dernier enregistrement
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, record));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

export type Vapid = { privateJwk: JsonWebKey; publicKey: string; subject: string };

export function vapidFromEnv(jwkJson: string | undefined, subject: string | undefined): Vapid | null {
  if (!jwkJson) return null;
  try {
    const jwk = JSON.parse(jwkJson) as JsonWebKey;
    if (!jwk.d || !jwk.x || !jwk.y) return null;
    const pub = concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y));
    return { privateJwk: jwk, publicKey: b64u(pub), subject: subject || "mailto:admin@example.com" };
  } catch {
    return null;
  }
}

async function vapidHeader(endpoint: string, v: Vapid): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject })));
  const key = await crypto.subtle.importKey("jwk", { ...v.privateJwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

export type Sub = { endpoint: string; p256dh: string; auth: string };

/** Envoie une notification. Retourne le statut HTTP (404/410 = abonnement expiré). */
export async function sendPush(sub: Sub, data: unknown, v: Vapid, opts: { ttl: number; urgency?: string; topic?: string }): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(data)), sub.p256dh, sub.auth);
  const headers: Record<string, string> = {
    authorization: await vapidHeader(sub.endpoint, v),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(opts.ttl),
    urgency: opts.urgency || "high",
  };
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const r = await fetch(sub.endpoint, { method: "POST", headers, body });
  return r.status;
}

/** Envoie à tous les appareils d'un utilisateur et nettoie les abonnements expirés. Retourne le nombre d'envois réussis. */
export async function pushToUser(db: D1Database, v: Vapid | null, userId: string, data: unknown, opts: { ttl: number; urgency?: string; topic?: string }): Promise<number> {
  if (!v) return 0;
  const { results } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?1").bind(userId).all<Sub>();
  let ok = 0;
  await Promise.all((results || []).map(async (s) => {
    try {
      const st = await sendPush(s, data, v, opts);
      if (st === 404 || st === 410) await db.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(s.endpoint).run();
      else if (st >= 200 && st < 300) ok++;
    } catch { /* réseau : on ignore */ }
  }));
  return ok;
}

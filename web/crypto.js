// Chiffrement de bout en bout, identique à app/.../Crypto.kt (objet E2E) :
// X25519 (clé partagée) + HKDF-SHA256 + AES-256-GCM.
// Format d'un message chiffré (comme Tink AesGcmJce) : IV (12 octets) || texte chiffré || tag (16 octets).
// Données associées (AAD) = sel = les deux clés publiques base64, triées puis concaténées.
(function (root) {
  const enc = new TextEncoder();
  const subtle = root.crypto.subtle;

  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function newKeyPair() {
    const kp = root.nacl.box.keyPair(); // secretKey = scalaire X25519, publicKey = X25519(base)
    return { priv: kp.secretKey, pub: kp.publicKey };
  }

  async function deriveKey(myPriv, myPubB64, theirPubB64) {
    const shared = root.nacl.scalarMult(myPriv, unb64(theirPubB64));
    const salt = enc.encode([myPubB64, theirPubB64].sort().join(""));
    const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("p2p-chat-v1") },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return { key, aad: salt };
  }

  async function encrypt(k, plain) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await subtle.encrypt({ name: "AES-GCM", iv, additionalData: k.aad, tagLength: 128 }, k.key, plain),
    );
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
  }

  async function decrypt(k, data) {
    const u8 = new Uint8Array(data);
    if (u8.length < 28) throw new Error("message trop court");
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: u8.subarray(0, 12), additionalData: k.aad, tagLength: 128 },
      k.key,
      u8.subarray(12),
    );
    return new Uint8Array(pt);
  }

  root.E2E = { b64, unb64, newKeyPair, deriveKey, encrypt, decrypt };
})(typeof window !== "undefined" ? window : globalThis);

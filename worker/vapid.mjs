// Génère la clé VAPID des notifications push et l'affiche (à envoyer dans `wrangler secret put`).
// Usage : npm run vapid
const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", k.privateKey);
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }));

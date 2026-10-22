// Service worker : interface hors ligne + notifications (messages et appels) quand l'app est fermée.
// Les messages restent chiffrés de bout en bout : le texte est déchiffré ici, sur le téléphone.
importScripts("config.js", "vendor/nacl-fast.min.js", "crypto.js");

const CACHE = "p2p-chat-3ed98680";
const SHELL = ["./", "index.html", "app.css", "app.js", "call.js", "crypto.js", "emoji.js", "emoji-fr.js", "vendor/qrcode.min.js", "config.js", "vendor/nacl-fast.min.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/badge-96.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});

// ---------------------------------------------------------------- Accès à la base de l'app

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("p2pchat", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("kv");
      d.createObjectStore("contacts", { keyPath: "id" });
      d.createObjectStore("msgs", { keyPath: "id" }).createIndex("peer", "peerId");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(store, key) {
  const db = await idb();
  return new Promise((res) => {
    const t = db.transaction(store, "readonly");
    const q = t.objectStore(store).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(undefined);
  });
}
async function idbPut(store, value) {
  const db = await idb();
  return new Promise((res) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put(value);
    t.oncomplete = () => res(true);
    t.onerror = () => res(false);
  });
}

async function directoryUrl() {
  const u = await idbGet("kv", "directoryUrl").catch(() => "");
  return (u || (self.P2P_CONFIG || {}).directoryUrl || "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------- Notifications

const ICON = "icons/icon-192.png";
const BADGE = "icons/badge-96.png";

async function decryptPreview(data) {
  // Retourne le texte du message, ou null si impossible (clé inconnue, message trop long pour la notif…)
  if (!data.ct) return null;
  const me = await idbGet("kv", "identity");
  if (!me) return null;
  const known = await idbGet("contacts", data.from);
  // Clé déjà mémorisée pour ce contact : on n'accepte qu'elle (même règle que l'app)
  const pub = known ? known.publicKey : data.key;
  if (!pub) return null;
  try {
    const k = await E2E.deriveKey(me.priv, me.pubB64, pub);
    const j = JSON.parse(new TextDecoder().decode(await E2E.decrypt(k, E2E.unb64(data.ct))));
    if (typeof j.react === "string") return j.react ? "a réagi " + j.react + " à ton message" : null;
    if (typeof j.text !== "string") return null;
    // On range le message tout de suite : il s'affichera à l'ouverture de l'app
    if (known && !(await idbGet("msgs", String(j.id)))) {
      await idbPut("msgs", { id: String(j.id), peerId: data.from, text: String(j.text), ts: Number(j.ts) || Date.now(), outgoing: false, sent: true, unread: true });
    }
    return String(j.text);
  } catch {
    return null;
  }
}

async function visibleClient() {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return list.find((c) => c.visibilityState === "visible");
}

async function onPush(data) {
  if (data.t === "msg") {
    const text = await decryptPreview(data);
    const ct_ = await idbGet("contacts", data.from).catch(() => null);
    const open = await visibleClient();
    if (open) open.postMessage({ type: "mailbox" });
    return self.registration.showNotification(data.name || "Nouveau message", {
      body: text ? (text.length > 180 ? text.slice(0, 177) + "…" : text) : "Nouveau message chiffré",
      icon: ICON, badge: BADGE,
      tag: "msg-" + data.from,
      renotify: !(ct_ && (ct_.muted || ct_.blocked)),
      silent: !!(ct_ && (ct_.muted || ct_.blocked)),
      data: { url: "./?chat=" + encodeURIComponent(data.from) },
    });
  }
  if (data.t === "call") {
    const what = data.video ? "Appel vidéo" : "Appel audio";
    return self.registration.showNotification((data.name || "Quelqu'un") + " t'appelle", {
      body: what + " · touche pour répondre",
      icon: ICON, badge: BADGE,
      tag: "call-" + data.callId,
      renotify: true,
      requireInteraction: true,
      vibrate: [600, 300, 600, 300, 600, 300, 600],
      actions: [
        { action: "answer", title: "Répondre" },
        { action: "decline", title: "Refuser" },
      ],
      data: { url: "./?call=" + encodeURIComponent(data.callId) + "&from=" + encodeURIComponent(data.from), callId: data.callId, from: data.from },
    });
  }
  if (data.t === "missed") {
    for (const n of await self.registration.getNotifications({ tag: "call-" + data.callId })) n.close();
    return self.registration.showNotification("Appel manqué", {
      body: (data.name || "Quelqu'un") + " a essayé de t'appeler",
      icon: ICON, badge: BADGE,
      tag: "call-" + data.callId,
      data: { url: "./?chat=" + encodeURIComponent(data.from) },
    });
  }
}

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(onPush(data).catch(() => self.registration.showNotification("P2P Chat", { body: "Nouvelle activité", icon: ICON })));
});

async function declineFromNotification(d) {
  const me = await idbGet("kv", "identity");
  const base = await directoryUrl();
  if (!me || !base) return;
  await fetch(base + "/call/decline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: me.id, token: me.token, to: d.from, callId: d.callId }),
  }).catch(() => {});
}

async function openApp(url) {
  const target = new URL(url, self.registration.scope).href;
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of list) {
    if (c.url.startsWith(self.registration.scope)) {
      await c.focus().catch(() => {});
      c.postMessage({ type: "open", url: target });
      return;
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  if (e.action === "decline" && d.callId) { e.waitUntil(declineFromNotification(d)); return; }
  let url = d.url || "./";
  if (e.action === "answer" && d.callId) url += "&answer=1";
  e.waitUntil(openApp(url));
});

// P2P Chat — version web installable (iPhone, Android, ordinateur).
// Même protocole que l'app Android : annuaire (Cloudflare Worker) pour la poignée de main,
// puis les messages passent directement d'appareil à appareil (WebRTC DataChannel), chiffrés.
"use strict";

const CFG = self.P2P_CONFIG || {};
const DEFAULT_ICE = CFG.iceServers || [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
let iceServers = DEFAULT_ICE;
let iceFetchedAt = 0;
const currentIceServers = () => iceServers;

/** Récupère auprès de l'annuaire les serveurs STUN/TURN (identifiants TURN temporaires). */
async function refreshIceServers(force) {
  const me = state.me, base = directoryUrl();
  if (!me || !base) return;
  if (!force && Date.now() - iceFetchedAt < 6 * 3600 * 1000) return;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(base + "/ice?id=" + encodeURIComponent(me.id) + "&token=" + encodeURIComponent(me.token), { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return;
    const j = await r.json();
    if (Array.isArray(j.iceServers) && j.iceServers.length) { iceServers = j.iceServers; iceFetchedAt = Date.now(); }
  } catch { /* annuaire ancien ou injoignable : STUN par défaut */ }
}
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- Stockage (IndexedDB)

let db;
function openDb() {
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
function req(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const kvGet = (k) => req("kv", "readonly", (s) => s.get(k));
const kvSet = (k, v) => req("kv", "readwrite", (s) => s.put(v, k));
const contactsAll = () => req("contacts", "readonly", (s) => s.getAll());
const contactGet = (id) => req("contacts", "readonly", (s) => s.get(id));
const contactPut = (c) => req("contacts", "readwrite", (s) => s.put(c));
const msgsFor = async (peerId) =>
  (await req("msgs", "readonly", (s) => s.index("peer").getAll(peerId))).sort((a, b) => a.ts - b.ts);
const msgGet = (id) => req("msgs", "readonly", (s) => s.get(id));
const msgPut = (m) => req("msgs", "readwrite", (s) => s.put(m));

// ---------------------------------------------------------------- Annuaire

function directoryUrl() {
  let u = "";
  try { u = localStorage.getItem("directoryUrl") || ""; } catch {}
  return (u || CFG.directoryUrl || "").trim().replace(/\/+$/, "");
}

async function api(path, opts) {
  const base = directoryUrl();
  if (!base) throw new Error("Indique l'adresse du serveur annuaire dans les réglages.");
  let r;
  try {
    r = await fetch(base + path, opts);
  } catch {
    throw new Error("Serveur annuaire injoignable. Vérifie ta connexion ou l'adresse du serveur.");
  }
  const j = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, json: j };
}

async function lookup(key) {
  const r = await api("/users/" + encodeURIComponent(key));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Erreur du serveur (" + r.status + ")");
  return { id: r.json.id, username: r.json.username, publicKey: r.json.publicKey };
}

// ---------------------------------------------------------------- Moteur

const state = {
  me: null,            // { id, username, token, priv: Uint8Array, pub: Uint8Array, pubB64 }
  screen: "setup",     // setup | home | chat
  peer: null,          // contact ouvert
  online: false,       // websocket annuaire
  peerStatus: {},      // peerId -> "direct" | "connecting" | "offline"
  installPrompt: null,
};

const sessions = new Map();
const keyCache = new Map();
let socket = null;
let reconnectDelay = 1000;

async function keyFor(contact) {
  const k = contact.id + ":" + contact.publicKey;
  if (!keyCache.has(k)) keyCache.set(k, E2E.deriveKey(state.me.priv, state.me.pubB64, contact.publicKey));
  return keyCache.get(k);
}

function connectSocket() {
  const me = state.me;
  const base = directoryUrl();
  if (!me || !base) return;
  const url = base.replace(/^http/, "ws") + "/ws?id=" + encodeURIComponent(me.id) + "&token=" + encodeURIComponent(me.token);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = async () => {
    reconnectDelay = 1000; state.online = true; render();
    fetchMailbox();
    await refreshIceServers();
    if (state.peer) openSession(state.peer.id);
    relayAllPending();
  };
  ws.onmessage = (e) => { try { handleSignal(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null; state.online = false; render();
    setTimeout(() => { if (!socket && state.me) connectSocket(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

function sendSignal(to, m) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify({ ...m, to }));
}

function setPeerStatus(id, s) {
  if (state.peerStatus[id] === s) return;
  state.peerStatus[id] = s;
  if (state.peer && state.peer.id === id) renderStatus();
}

function handleSignal(m) {
  const from = m.from;
  if (!from || !state.me) return;
  if (m.type === "mailbox") { fetchMailbox(); return; }
  if (m.type === "offline") {
    setPeerStatus(from, "offline");
    relayPending(from, true);
    if (window.onCallSignal) window.onCallSignal(m);
    return;
  }
  if (typeof m.type === "string" && m.type.startsWith("call-")) { if (window.onCallSignal) window.onCallSignal(m); return; }
  if (m.type === "offer") {
    const old = sessions.get(from);
    if (old && old.isCaller && state.me.id < from) return; // conflit : je reste l'appelant (même règle qu'Android)
    if (old) old.close();
    const s = new PeerSession(from, false);
    sessions.set(from, s);
    s.onSignal(m);
  } else if (m.type === "answer" || m.type === "ice") {
    const s = sessions.get(from);
    if (s) s.onSignal(m);
  }
}

class PeerSession {
  constructor(peerId, caller) {
    this.peerId = peerId;
    this.isCaller = caller;
    this.createdAt = Date.now();
    this.pendingIce = [];
    this.remoteSet = false;
    this.dc = null;
    this.closed = false;
    const pc = (this.pc = new RTCPeerConnection({ iceServers: currentIceServers() }));
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate) return;
      sendSignal(peerId, { type: "ice", sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, candidate: c.candidate });
    };
    pc.ondatachannel = (e) => this.attach(e.channel);
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "failed" || s === "closed") this.drop();
    };
    if (caller) {
      this.attach(pc.createDataChannel("chat"));
      pc.createOffer()
        .then((d) => pc.setLocalDescription(d))
        .then(() => sendSignal(peerId, { type: "offer", sdp: pc.localDescription.sdp }))
        .catch(() => this.drop());
    }
    setPeerStatus(peerId, "connecting");
  }
  get isOpen() { return !!this.dc && this.dc.readyState === "open"; }
  attach(ch) {
    this.dc = ch;
    ch.binaryType = "arraybuffer";
    ch.onopen = () => { setPeerStatus(this.peerId, "direct"); flush(this.peerId); };
    ch.onclose = () => this.drop();
    ch.onmessage = (e) => {
      const data = typeof e.data === "string" ? enc.encode(e.data) : new Uint8Array(e.data);
      receive(this.peerId, data);
    };
  }
  remoteReady() {
    this.remoteSet = true;
    for (const c of this.pendingIce) this.pc.addIceCandidate(c).catch(() => {});
    this.pendingIce = [];
  }
  async onSignal(m) {
    try {
      if (m.type === "offer") {
        await this.pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        this.remoteReady();
        const a = await this.pc.createAnswer();
        await this.pc.setLocalDescription(a);
        sendSignal(this.peerId, { type: "answer", sdp: this.pc.localDescription.sdp });
      } else if (m.type === "answer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
        this.remoteReady();
      } else if (m.type === "ice") {
        const c = { candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex };
        if (this.remoteSet) await this.pc.addIceCandidate(c); else this.pendingIce.push(c);
      }
    } catch (e) { console.warn("signal", e); }
  }
  send(bytes) {
    if (!this.isOpen) return false;
    try { this.dc.send(bytes); return true; } catch { return false; }
  }
  drop() {
    if (sessions.get(this.peerId) === this) {
      sessions.delete(this.peerId);
      if (state.peerStatus[this.peerId] !== "offline") setPeerStatus(this.peerId, "connecting");
    }
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}

/** Pré-chauffe la connexion à l'ouverture d'une conversation. */
function openSession(peerId) {
  if (!socket || socket.readyState !== 1) return;
  const s = sessions.get(peerId);
  if (!s || (!s.isOpen && Date.now() - s.createdAt > 15000)) {
    if (s) s.close();
    sessions.set(peerId, new PeerSession(peerId, true));
  }
}

let flushing = new Set();
async function flush(peerId) {
  if (flushing.has(peerId)) return;
  flushing.add(peerId);
  try {
    const s = sessions.get(peerId);
    if (!s || !s.isOpen) return;
    const c = await contactFor(peerId);
    if (!c) return;
    const k = await keyFor(c);
    const pending = (await msgsFor(peerId)).filter((m) => m.outgoing && !m.sent && !m.kind);
    for (const m of pending) {
      const plain = enc.encode(JSON.stringify({ id: m.id, ts: m.ts, text: m.text }));
      const ct = await E2E.encrypt(k, plain);
      if (!s.send(ct)) break;
      m.sent = true;
      await msgPut(m);
    }
  } finally {
    flushing.delete(peerId);
    if (state.peer && state.peer.id === peerId) renderThread();
  }
}

async function receive(peerId, bytes, batch) {
  try {
    const c = await contactFor(peerId);
    if (!c) return;
    const j = JSON.parse(dec.decode(await E2E.decrypt(await keyFor(c), bytes)));
    if (await msgGet(String(j.id))) return;
    await msgPut({ id: String(j.id), peerId, text: String(j.text), ts: Number(j.ts) || Date.now(), outgoing: false, sent: true });
    if (batch) return;
    if (state.peer && state.peer.id === peerId) renderThread();
    else if (state.screen === "home") renderHome();
  } catch (e) { console.warn("message illisible", e); }
}

async function contactFor(id) {
  let c = await contactGet(id);
  if (!c) {
    c = await lookup(id).catch(() => null);
    if (c) await contactPut(c);
  }
  return c;
}

async function register(username) {
  const kp = E2E.newKeyPair();
  const pubB64 = E2E.b64(kp.pub);
  const r = await api("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, publicKey: pubB64 }),
  });
  if (!r.ok) throw new Error((r.json && r.json.error) || "Erreur du serveur (" + r.status + ")");
  const me = { id: r.json.id, username, token: r.json.token, priv: kp.priv, pub: kp.pub, pubB64 };
  await kvSet("identity", me);
  state.me = me;
  connectSocket();
  enablePush(true).catch(() => {});
}

async function addContact(name) {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error("Écris le nom d'utilisateur de ton contact.");
  if (key === state.me.username) throw new Error("C'est ton propre nom.");
  const c = await lookup(key);
  if (!c) throw new Error("Aucun compte « " + key + " ». Vérifie l'orthographe.");
  const old = await contactGet(c.id);
  if (old && old.publicKey !== c.publicKey) throw new Error("⚠ La clé de " + c.username + " a changé. Contact non mis à jour.");
  await contactPut(c);
  return c;
}

async function sendText(peerId, text) {
  const m = { id: crypto.randomUUID(), peerId, text: text.slice(0, 4000), ts: Date.now(), outgoing: true, sent: false };
  await msgPut(m);
  renderThread();
  openSession(peerId);
  flush(peerId);
  // Pas de connexion directe dans 3 s (contact hors ligne, app fermée…) : boîte aux lettres chiffrée.
  setTimeout(() => relayPending(peerId), 3000);
}

// ---------------------------------------------------------------- Boîte aux lettres (contact hors ligne)

const relaying = new Set();
/** Envoie via l'annuaire les messages pas encore partis en direct. Le serveur ne voit que du chiffré. */
async function relayPending(peerId, force) {
  if (relaying.has(peerId) || !state.me) return;
  relaying.add(peerId);
  try {
    const s = sessions.get(peerId);
    if (s && s.isOpen) return; // la connexion directe s'en charge
    const c = await contactFor(peerId);
    if (!c) return;
    const k = await keyFor(c);
    const now = Date.now();
    const pending = (await msgsFor(peerId)).filter((m) => m.outgoing && !m.sent && !m.kind && (force || now - m.ts >= 2500));
    for (const m of pending) {
      const ct = E2E.b64(await E2E.encrypt(k, enc.encode(JSON.stringify({ id: m.id, ts: m.ts, text: m.text }))));
      const r = await api("/mailbox/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: state.me.id, token: state.me.token, to: peerId, msgId: m.id, ct }),
      }).catch(() => null);
      if (!r || !r.ok) break;
      m.sent = true;
      m.relayed = true;
      await msgPut(m);
    }
  } finally {
    relaying.delete(peerId);
    if (state.peer && state.peer.id === peerId) renderThread();
  }
}

async function relayAllPending() {
  for (const c of await contactsAll()) relayPending(c.id);
}

let fetchingMailbox = false;
/** Récupère les messages reçus pendant que l'app était fermée. */
async function fetchMailbox() {
  if (fetchingMailbox || !state.me || !directoryUrl()) return;
  fetchingMailbox = true;
  try {
    const r = await api("/mailbox?id=" + encodeURIComponent(state.me.id) + "&token=" + encodeURIComponent(state.me.token)).catch(() => null);
    if (!r || !r.ok || !r.json || !Array.isArray(r.json.messages)) return;
    const done = [];
    const touched = new Set();
    for (const m of r.json.messages) {
      try {
        await receive(m.fromId, E2E.unb64(m.ct), true);
        touched.add(m.fromId);
      } catch {}
      done.push(m.msgId);
    }
    if (done.length) {
      await api("/mailbox/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: state.me.id, token: state.me.token, ids: done }),
      }).catch(() => {});
    }
    if (touched.size) {
      if (state.peer && touched.has(state.peer.id)) renderThread();
      else if (state.screen === "home") renderHome();
    }
  } finally {
    fetchingMailbox = false;
  }
}

// ---------------------------------------------------------------- Notifications push

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function b64uToBytes(s) {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "===".slice((b.length + 3) % 4)), (c) => c.charCodeAt(0));
}

/** Abonne cet appareil (après accord de l'utilisateur). silent = ne rien demander, seulement rafraîchir. */
async function enablePush(silent) {
  if (!pushSupported() || !state.me) return "unsupported";
  if (silent && Notification.permission !== "granted") return Notification.permission;
  if (!silent) {
    const p = await Notification.requestPermission();
    if (p !== "granted") return p;
  }
  const keyRes = await api("/push/key").catch(() => null);
  if (!keyRes || !keyRes.ok) return "server";
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = b64uToBytes(keyRes.json.key);
  if (sub && sub.options && sub.options.applicationServerKey) {
    const old = new Uint8Array(sub.options.applicationServerKey);
    if (old.length !== key.length || old.some((v, i) => v !== key[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON();
  const r = await api("/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: state.me.id, token: state.me.token, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }),
  });
  return r.ok ? "granted" : "server";
}

function pushBanner() {
  if (!state.me) return null;
  if (isIOS && !isStandalone()) return null; // l'invitation à installer passe d'abord
  if (!pushSupported()) return null;
  if (Notification.permission === "granted") return null;
  if (Notification.permission === "denied") {
    return h("div", { class: "install-hint" }, h("span", {}, "Notifications bloquées : autorise-les dans les réglages du téléphone pour recevoir messages et appels quand l'app est fermée."));
  }
  const btn = h("button", { class: "btn", onclick: async () => {
    btn.disabled = true;
    const r = await enablePush(false).catch(() => "server");
    if (r === "server") alert("Le serveur n'a pas encore les notifications activées. Voir le README (npm run vapid).");
    render();
  } }, "Activer");
  return h("div", { class: "install-hint" }, h("span", {}, "Active les notifications pour recevoir messages et appels même quand l'app est fermée."), btn);
}

// ---------------------------------------------------------------- Interface

const root = document.getElementById("root");
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const svg = (path) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = path;
  return s;
};
const ICON_BACK = '<path d="M15 5l-7 7 7 7"/>';
const ICON_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';
const ICON_CALL = '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>';
const ICON_CAM = '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>';
const ICON_SEND = '<path d="M5 12h13M13 6l6 6-6 6"/>';
const MARK = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="10" width="20" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><rect x="40" y="14" width="20" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 31h16" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/></svg>';

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function render() {
  if (state.screen === "setup") return renderSetup();
  if (state.screen === "home") return renderHome();
  if (state.screen === "chat") return renderChat();
}

function renderSetup() {
  const err = h("p", { class: "error", role: "alert" });
  const name = h("input", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "20", placeholder: "ex. lina_92", required: true });
  const server = h("input", { type: "url", placeholder: "https://…workers.dev", value: directoryUrl() });
  const btn = h("button", { class: "btn", type: "submit", disabled: true }, "Créer mon compte");
  name.addEventListener("input", () => {
    name.value = name.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    btn.disabled = name.value.length < 3;
  });
  const needServer = !CFG.directoryUrl;
  const serverField = h("label", { class: "field" }, "Adresse du serveur annuaire",
    h("small", {}, "Fournie par la personne qui a installé le serveur."), server);
  const form = h("form", { class: "setup", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    try { const v = server.value.trim(); if (v !== (CFG.directoryUrl || "")) localStorage.setItem("directoryUrl", v); } catch {}
    btn.disabled = true; btn.textContent = "Création…";
    try { await register(name.value); state.screen = "home"; render(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Créer mon compte"; }
  } });
  const mark = h("div"); mark.innerHTML = MARK;
  form.append(
    mark.firstChild,
    h("h1", {}, "P2P Chat"),
    h("p", {}, "Tes messages vont directement de ton téléphone à celui de ton contact, chiffrés. Aucun serveur ne les lit ni ne les garde."),
    h("label", { class: "field" }, "Ton nom d'utilisateur", h("small", {}, "3 à 20 caractères : lettres, chiffres, _"), name),
    needServer ? serverField : h("details", { class: "server" }, h("summary", {}, "Serveur annuaire"), serverField),
    err, btn,
  );
  root.replaceChildren(form);
  name.focus();
}

function installHint() {
  if (isStandalone()) return null;
  if (state.installPrompt) {
    return h("div", { class: "install-hint" }, h("span", {}, "Installe P2P Chat sur ton écran d'accueil."),
      h("button", { class: "btn", onclick: async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; render(); } }, "Installer"));
  }
  if (isIOS) {
    return h("div", { class: "install-hint" }, h("span", {}, "Pour l'installer : touche le bouton Partager de Safari, puis « Sur l'écran d'accueil »."));
  }
  return null;
}

async function renderHome() {
  if (state.screen !== "home") return;
  const err = h("p", { class: "error", role: "alert", style: "padding:0 16px" });
  const input = h("input", { type: "text", placeholder: "Nom d'utilisateur", autocapitalize: "none", autocomplete: "off", spellcheck: "false", "aria-label": "Nom d'utilisateur du contact" });
  const form = h("form", { class: "add", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    try { const c = await addContact(input.value); openChat(c); } catch (x) { err.textContent = x.message; }
  } }, input, h("button", { class: "btn", type: "submit" }, "Ajouter"));

  const contacts = (await contactsAll()).sort((a, b) => a.username.localeCompare(b.username));
  const items = await Promise.all(contacts.map(async (c) => {
    const ms = await msgsFor(c.id);
    const last = ms[ms.length - 1];
    return h("li", {}, h("button", { onclick: () => openChat(c) },
      h("span", { class: "avatar", "aria-hidden": "true" }, c.username[0].toUpperCase()),
      h("span", {}, h("div", { class: "name" }, c.username),
        h("div", { class: "preview" }, last ? (last.outgoing ? "Toi : " : "") + last.text : "Aucun message"))));
  }));
  if (state.screen !== "home") return;
  root.replaceChildren(
    h("header", { class: "bar" }, h("h2", {}, "Contacts"),
      h("span", { class: "status" }, h("span", { class: "dot" + (state.online ? " on" : "") }), state.online ? state.me.username : "hors ligne"),
      h("button", { class: "icon-btn", "aria-label": "Réglages", onclick: openSettings }, svg(ICON_GEAR))),
    installHint() || "",
    pushBanner() || "",
    form, err,
    items.length ? h("ul", { class: "list" }, items)
      : h("p", { class: "empty" }, "Ajoute un contact avec son nom d'utilisateur pour commencer. Il doit avoir créé son compte dans P2P Chat, sur Android ou sur le web."),
  );
}

function openChat(c) {
  state.peer = c; state.screen = "chat";
  history.pushState({ chat: c.id }, "");
  render();
  openSession(c.id);
}

function closeChat() { state.peer = null; state.screen = "home"; render(); }
window.addEventListener("popstate", () => { if (state.screen === "chat") closeChat(); });

let statusEl = null, threadEl = null;
function renderChat() {
  const c = state.peer;
  statusEl = h("div", { class: "status" });
  threadEl = h("div", { class: "thread", role: "log" });
  const input = h("input", { type: "text", placeholder: "Message", autocomplete: "off", enterkeyhint: "send", "aria-label": "Message" });
  const form = h("form", { class: "composer", onsubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = "";
    sendText(c.id, t);
  } }, input, h("button", { class: "btn", type: "submit", "aria-label": "Envoyer" }, svg(ICON_SEND)));
  root.replaceChildren(
    h("header", { class: "bar" },
      h("button", { class: "icon-btn", "aria-label": "Retour aux contacts", onclick: () => history.back() }, svg(ICON_BACK)),
      h("div", { class: "peer-title" }, h("h2", {}, c.username), statusEl),
      h("button", { class: "icon-btn", "aria-label": "Appel audio", title: "Appel audio", onclick: () => window.startCall && window.startCall(c, false) }, svg(ICON_CALL)),
      h("button", { class: "icon-btn", "aria-label": "Appel vidéo", title: "Appel vidéo", onclick: () => window.startCall && window.startCall(c, true) }, svg(ICON_CAM))),
    threadEl, form,
  );
  renderStatus();
  renderThread();
  input.focus();
}

function renderStatus() {
  if (!statusEl || !state.peer) return;
  const s = state.online ? state.peerStatus[state.peer.id] : "me-offline";
  const text = {
    direct: "connexion directe, chiffrée",
    connecting: "connexion…",
    offline: "hors ligne : tes messages partiront à son retour",
    "me-offline": "tu es hors ligne",
  }[s] || "connexion…";
  statusEl.replaceChildren(h("span", { class: "dot" + (s === "direct" ? " on" : "") }), text);
}

let threadToken = 0;
async function renderThread() {
  if (!threadEl || !state.peer) return;
  const my = ++threadToken;
  const ms = await msgsFor(state.peer.id);
  if (my !== threadToken || !threadEl) return;
  const fmt = new Intl.DateTimeFormat("fr", { hour: "2-digit", minute: "2-digit" });
  threadEl.replaceChildren(
    ...(ms.length ? [] : [h("p", { class: "note" }, "Les messages passent uniquement entre vos deux appareils. Ils doivent être ouverts tous les deux pour que le message parte.")]),
    ...ms.map((m) => m.kind === "call"
      ? h("p", { class: "call-log" }, m.text + " · " + fmt.format(m.ts))
      : h("div", { class: "msg " + (m.outgoing ? "out" : "in") }, m.text,
      h("time", {}, fmt.format(m.ts) + (m.outgoing && !m.sent ? " · en attente" : "")))),
  );
  threadEl.scrollTop = threadEl.scrollHeight;
}

async function openSettings() {
  const server = h("input", { type: "url", value: directoryUrl() });
  const dlg = h("dialog", {});
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(h("form", { method: "dialog", class: "stack", onsubmit: (e) => {
    e.preventDefault();
    const v = server.value.trim();
    try { if (v && v !== CFG.directoryUrl) localStorage.setItem("directoryUrl", v); else localStorage.removeItem("directoryUrl"); } catch {}
    kvSet("directoryUrl", directoryUrl()).catch(() => {});
    if (socket) { const s = socket; socket = null; s.close(); }
    connectSocket(); close(); render();
  } },
    h("h3", {}, "Réglages"),
    h("div", {}, h("strong", {}, "Ton nom : "), state.me.username),
    h("div", {}, h("strong", {}, "Ta clé publique"), h("div", { class: "fp" }, state.me.pubB64)),
    h("label", { class: "field" }, "Serveur annuaire", server),
    h("div", { class: "row" },
      h("button", { class: "btn danger", type: "button", onclick: async () => {
        if (!confirm("Supprimer ton compte et tes messages de cet appareil ? Ton nom restera pris sur le serveur.")) return;
        db.close();
        await new Promise((r) => { const d = indexedDB.deleteDatabase("p2pchat"); d.onsuccess = d.onerror = d.onblocked = r; });
        location.reload();
      } }, "Effacer cet appareil"),
      h("button", { class: "btn ghost", type: "button", onclick: close }, "Fermer"),
      h("button", { class: "btn", type: "submit" }, "Enregistrer"))));
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------------------------------------------------------- Démarrage

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); state.installPrompt = e; if (state.screen === "home") render(); });
// En arrière-plan, on se déconnecte de l'annuaire : il sait alors qu'il doit envoyer une notification push
// (sinon un téléphone en veille garderait une connexion « fantôme » et ne serait jamais prévenu).
document.addEventListener("visibilitychange", () => {
  if (!state.me) return;
  if (document.visibilityState === "hidden") {
    const inCall = typeof window.isInCall === "function" && window.isInCall();
    if (!inCall && socket) { const s = socket; socket = null; state.online = false; s.close(1000, "background"); }
  } else {
    if (!socket) connectSocket();
    else fetchMailbox();
  }
});

/** Ouvre ce que demande une notification (?chat=… ou ?call=…). */
async function handleLink(href) {
  let u;
  try { u = new URL(href, location.href); } catch { return; }
  const chat = u.searchParams.get("chat");
  const callId = u.searchParams.get("call");
  if (callId) {
    window.pendingAnswer = { callId, auto: u.searchParams.get("answer") === "1" };
    if (u.searchParams.get("from")) { const c = await contactFor(u.searchParams.get("from")); if (c && state.screen !== "chat") openChat(c); }
  } else if (chat) {
    const c = await contactFor(chat);
    if (c) openChat(c);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open" && state.me) handleLink(e.data.url);
    if (e.data && e.data.type === "mailbox" && state.me) fetchMailbox();
  });
}

(async function start() {
  if (!window.crypto || !crypto.subtle || !window.RTCPeerConnection || !window.indexedDB) {
    root.replaceChildren(h("p", { class: "empty" }, "Ce navigateur ne permet pas les connexions directes chiffrées. Ouvre P2P Chat dans Safari (iPhone) ou Chrome (Android)."));
    return;
  }
  db = await openDb();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  const me = await kvGet("identity");
  // Le service worker (notifications) lit l'adresse de l'annuaire ici
  try { await kvSet("directoryUrl", directoryUrl()); } catch {}
  if (me) { state.me = me; state.screen = "home"; connectSocket(); }
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(() => enablePush(true)).catch(() => {});
  }
  if (me && /[?&](chat|call)=/.test(location.search)) {
    await handleLink(location.href);
    history.replaceState(history.state, "", location.pathname);
  }
})();

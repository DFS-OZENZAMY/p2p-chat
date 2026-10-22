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
  tab: "chats",        // chats | calls | settings (écran d'accueil)
  search: "",
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
    reconnectDelay = 1000; state.online = true;
    if (state.screen === "chat") renderStatus(); else if (state.screen === "home") renderTab(true);
    fetchMailbox();
    await refreshIceServers();
    if (state.peer) openSession(state.peer.id);
    relayAllPending();
  };
  ws.onmessage = (e) => { try { handleSignal(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null; state.online = false;
    if (state.screen === "chat") renderStatus(); else if (state.screen === "home") renderTab(true);
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
  else if (state.screen === "home" && state.tab === "chats") scheduleListRefresh();
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
    const seen = state.screen === "chat" && state.peer && state.peer.id === peerId && document.visibilityState === "visible";
    await msgPut({ id: String(j.id), peerId, text: String(j.text), ts: Number(j.ts) || Date.now(), outgoing: false, sent: true, unread: !seen });
    if (batch) return;
    if (state.peer && state.peer.id === peerId) renderThread();
    else if (state.screen === "home") scheduleListRefresh();
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
      if (state.peer && touched.has(state.peer.id)) { markRead(state.peer.id); renderThread(); }
      else if (state.screen === "home") scheduleListRefresh();
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

// ---------------------------------------------------------------- Interface
// Design : maquettes Figma « P2P Chat — UX/UI » (discussions, conversation, appels, réglages).

const root = document.getElementById("root");
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const svg = (path, cls) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = path;
  return s;
};

const I = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  checks: '<path d="M2 12l4 4 10-10M11 15.5l.5.5 10-10"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  link: '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  phoneIn: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M15 3v6h6M21 3l-6 6"/>',
  phoneOut: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M21 9V3h-6M15 9l6-6"/>',
  phoneMissed: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M15 3l6 6M21 3l-6 6"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};
const MARK = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="10" width="20" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><rect x="40" y="14" width="20" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 31h16" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/></svg>';

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---------- Petites aides d'affichage

const TINTS = ["t0", "t1", "t2", "t3", "t4", "t5"];
function tintFor(name) {
  let x = 0;
  for (const ch of String(name)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return TINTS[x % TINTS.length];
}
function avatar(name, size = "m", direct = false) {
  const a = h("span", { class: "avatar " + size + " " + tintFor(name), "aria-hidden": "true" }, String(name || "?")[0].toUpperCase());
  if (!direct) return a;
  return h("span", { class: "avatar-wrap" }, a, h("span", { class: "direct-dot", title: "Connexion directe établie" }));
}
const timeFmt = new Intl.DateTimeFormat("fr", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr", { weekday: "long", day: "numeric", month: "long" });
const shortDay = new Intl.DateTimeFormat("fr", { weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("fr", { day: "2-digit", month: "2-digit" });
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function listTime(ts) {
  const d0 = startOfDay(Date.now()), d = startOfDay(ts), days = Math.round((d0 - d) / 86400000);
  if (days === 0) return timeFmt.format(ts);
  if (days === 1) return "Hier";
  if (days < 7) return shortDay.format(ts);
  return dateFmt.format(ts);
}
function dayLabel(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  const s = dayFmt.format(ts);
  return s[0].toUpperCase() + s.slice(1);
}
const isDirect = (id) => { const s = sessions.get(id); return !!(s && s.isOpen); };

async function markRead(peerId) {
  const ms = await msgsFor(peerId);
  for (const m of ms) if (m.unread) { m.unread = false; await msgPut(m); }
}

let listTimer = null;
function scheduleListRefresh() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => { if (state.screen === "home") renderTab(); }, 120);
}

// ---------- Routage

function render() {
  if (state.screen === "setup") return renderSetup();
  if (state.screen === "home") return renderHome();
  if (state.screen === "chat") return renderChat();
}
const renderHome = () => renderTab(true);

// ---------- Bienvenue / inscription

function renderSetup() {
  const err = h("p", { class: "error", role: "alert" });
  const name = h("input", { type: "text", id: "username", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "20", placeholder: "ex. lina_92", required: true });
  const server = h("input", { type: "url", id: "server", placeholder: "https://…workers.dev", value: directoryUrl() });
  const btn = h("button", { class: "btn primary block", type: "submit", disabled: true }, "Créer mon compte");
  name.addEventListener("input", () => {
    name.value = name.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    btn.disabled = name.value.length < 3;
  });
  const serverField = h("div", { class: "field" }, h("label", { for: "server" }, "Adresse du serveur annuaire"),
    server, h("small", {}, "Fournie par la personne qui a installé le serveur."));
  const form = h("form", { class: "screen setup", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    try { const v = server.value.trim(); if (v !== (CFG.directoryUrl || "")) localStorage.setItem("directoryUrl", v); } catch {}
    btn.disabled = true; btn.textContent = "Création…";
    try { await register(name.value); kvSet("directoryUrl", directoryUrl()).catch(() => {}); state.screen = "home"; state.tab = "chats"; render(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Créer mon compte"; }
  } });
  const mark = h("div", { class: "mark-wrap" }); mark.innerHTML = MARK;
  form.append(
    h("div", { class: "setup-body" },
      mark,
      h("h1", { class: "display" }, "Écris en direct, sans intermédiaire."),
      h("p", { class: "lede" }, "Tes messages et tes appels vont de ton téléphone à celui de ton contact, chiffrés. Aucun serveur ne peut les lire."),
      h("div", { class: "field" }, h("label", { for: "username" }, "Choisis ton nom d'utilisateur"), name, h("small", {}, "3 à 20 caractères : lettres, chiffres, _")),
      CFG.directoryUrl ? h("details", { class: "server" }, h("summary", {}, "Serveur annuaire"), serverField) : serverField,
      err),
    h("div", { class: "setup-foot" }, btn, h("p", { class: "fineprint" }, "Pas d'e-mail, pas de numéro de téléphone.")),
  );
  root.replaceChildren(form);
  name.focus();
}

// ---------- Accueil : barre d'onglets

function tabBar() {
  const tab = (id, label, icon) => h("button", {
    class: "tab" + (state.tab === id ? " on" : ""), "aria-current": state.tab === id ? "page" : false,
    onclick: () => { if (state.tab !== id) { state.tab = id; renderTab(true); } },
  }, svg(icon), h("span", {}, label));
  return h("nav", { class: "tabbar", "aria-label": "Navigation" },
    tab("chats", "Discussions", I.chat), tab("calls", "Appels", I.phone), tab("settings", "Réglages", I.settings));
}

function banners() {
  const out = [];
  if (!isStandalone()) {
    if (state.installPrompt) {
      out.push(h("div", { class: "banner" }, svg(I.download), h("span", {}, "Installe P2P Chat sur ton écran d'accueil."),
        h("button", { class: "btn primary small", onclick: async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; renderTab(true); } }, "Installer")));
    } else if (isIOS) {
      out.push(h("div", { class: "banner" }, svg(I.download), h("span", {}, "Pour installer l'app : bouton Partager de Safari, puis « Sur l'écran d'accueil ». Les notifications ne marchent qu'une fois l'app installée.")));
    }
  }
  if (!(isIOS && !isStandalone()) && pushSupported() && Notification.permission !== "granted") {
    if (Notification.permission === "denied") {
      out.push(h("div", { class: "banner warn" }, svg(I.bell), h("span", {}, "Notifications bloquées. Autorise-les dans les réglages du téléphone pour recevoir messages et appels app fermée.")));
    } else {
      const b = h("button", { class: "btn primary small", onclick: async () => {
        b.disabled = true;
        const r = await enablePush(false).catch(() => "server");
        if (r === "server") alert("Le serveur n'a pas encore les notifications activées (npm run vapid, voir le README).");
        renderTab(true);
      } }, "Activer");
      out.push(h("div", { class: "banner" }, svg(I.bell), h("span", {}, "Reçois messages et appels même quand l'app est fermée."), b));
    }
  }
  return out;
}

function renderTab(full) {
  if (state.screen !== "home") return;
  if (state.tab === "calls") return renderCalls();
  if (state.tab === "settings") return renderSettings();
  return renderChats(full);
}

// ---------- Onglet Discussions

let chatListEl = null;
async function renderChats(full) {
  if (full || !chatListEl || !root.contains(chatListEl)) {
    chatListEl = h("ul", { class: "rows", "aria-label": "Discussions" });
    const search = h("input", { type: "search", placeholder: "Rechercher", "aria-label": "Rechercher une discussion", value: state.search });
    search.addEventListener("input", () => { state.search = search.value; fillChatList(); });
    root.replaceChildren(h("div", { class: "screen" },
      h("header", { class: "large-head" },
        h("div", { class: "head-row" },
          h("h1", { class: "display" }, "Discussions"),
          h("button", { class: "round-btn tint", "aria-label": "Nouvelle discussion", title: "Nouvelle discussion", onclick: openNewChat }, svg(I.plus))),
        h("label", { class: "searchbar" }, svg(I.search), search),
        h("p", { class: "presence" + (state.online ? " on" : "") }, h("span", { class: "dot" }), state.online ? "Connecté · " + state.me.username : "Hors ligne · reconnexion…")),
      h("div", { class: "scroll" }, ...banners(), chatListEl),
      tabBar()));
  }
  await fillChatList();
}

async function fillChatList() {
  if (!chatListEl) return;
  const q = state.search.trim().toLowerCase();
  const contacts = await contactsAll();
  const items = await Promise.all(contacts.map(async (c) => {
    const ms = await msgsFor(c.id);
    const last = ms[ms.length - 1];
    return { c, last, unread: ms.filter((m) => m.unread).length, ts: last ? last.ts : 0 };
  }));
  items.sort((a, b) => b.ts - a.ts || a.c.username.localeCompare(b.c.username));
  const shown = items.filter((x) => !q || x.c.username.includes(q));
  if (!items.length) {
    chatListEl.replaceChildren(h("li", { class: "empty" },
      h("p", {}, "Aucune discussion pour l'instant."),
      h("p", { class: "muted" }, "Ajoute un contact avec son nom d'utilisateur. Il doit avoir créé son compte dans P2P Chat, sur Android ou sur le web."),
      h("button", { class: "btn primary", onclick: openNewChat }, "Ajouter un contact")));
    return;
  }
  if (!shown.length) { chatListEl.replaceChildren(h("li", { class: "empty" }, h("p", { class: "muted" }, "Aucun contact ne correspond à « " + q + " »."))); return; }
  chatListEl.replaceChildren(...shown.map(({ c, last, unread }) => {
    let preview = "Aucun message";
    if (last) preview = (last.kind === "call" ? "" : last.outgoing ? "Toi : " : "") + last.text;
    return h("li", {}, h("button", { class: "row", onclick: () => openChat(c) },
      avatar(c.username, "m", isDirect(c.id)),
      h("span", { class: "row-main" },
        h("span", { class: "row-top" }, h("span", { class: "row-name" }, c.username),
          last ? h("span", { class: "row-time" + (unread ? " accent" : "") }, listTime(last.ts)) : ""),
        h("span", { class: "row-bottom" }, h("span", { class: "row-preview" }, preview),
          unread ? h("span", { class: "badge", "aria-label": unread + " non lus" }, String(unread)) : ""))));
  }));
}

function openNewChat() {
  const err = h("p", { class: "error", role: "alert" });
  const input = h("input", { type: "text", placeholder: "Nom d'utilisateur", autocapitalize: "none", autocomplete: "off", spellcheck: "false", "aria-label": "Nom d'utilisateur du contact" });
  const dlg = h("dialog", { class: "sheet" });
  const close = () => { dlg.close(); dlg.remove(); };
  const go = h("button", { class: "btn primary", type: "submit" }, "Ouvrir la discussion");
  dlg.append(h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; go.disabled = true;
    try { const c = await addContact(input.value); close(); openChat(c); }
    catch (x) { err.textContent = x.message; go.disabled = false; }
  } },
    h("h2", { class: "title" }, "Nouvelle discussion"),
    h("p", { class: "muted" }, "Écris le nom d'utilisateur de ton contact."),
    input, err,
    h("div", { class: "row-actions" }, h("button", { class: "btn ghost", type: "button", onclick: close }, "Annuler"), go)));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
}

// ---------- Onglet Appels

async function renderCalls() {
  const filter = state.callFilter || "all";
  const contacts = await contactsAll();
  const logs = [];
  for (const c of contacts) for (const m of await msgsFor(c.id)) if (m.kind === "call") logs.push({ c, m });
  logs.sort((a, b) => b.m.ts - a.m.ts);
  const missed = (m) => m.status === "missed" || (!m.status && /manqué/.test(m.text));
  const shown = filter === "missed" ? logs.filter((x) => missed(x.m)) : logs;
  const seg = (id, label) => h("button", { class: "seg" + (filter === id ? " on" : ""), "aria-pressed": filter === id ? "true" : "false", onclick: () => { state.callFilter = id; renderCalls(); } }, label);
  const rows = shown.map(({ c, m }) => {
    const video = m.video != null ? m.video : /vidéo/i.test(m.text);
    const miss = missed(m);
    const icon = miss ? I.phoneMissed : m.outgoing ? I.phoneOut : I.phoneIn;
    let detail = video ? "Vidéo" : "Audio";
    if (m.duration) detail += " · " + m.duration;
    else if (miss) detail += " · manqué";
    else if (m.status === "declined") detail += " · refusé";
    else if (m.status === "noanswer") detail += " · sans réponse";
    return h("li", { class: "row static" },
      avatar(c.username, "s"),
      h("button", { class: "row-main link", onclick: () => openChat(c) },
        h("span", { class: "row-name" + (miss ? " danger" : "") }, c.username),
        h("span", { class: "row-detail" }, svg(icon, miss ? "danger" : ""), detail + " · " + listTime(m.ts))),
      h("button", { class: "round-btn tint", "aria-label": (video ? "Appel vidéo" : "Appel audio") + " à " + c.username,
        onclick: () => window.startCall && window.startCall(c, video) }, svg(video ? I.video : I.phone)));
  });
  root.replaceChildren(h("div", { class: "screen" },
    h("header", { class: "large-head" },
      h("h1", { class: "display" }, "Appels"),
      h("div", { class: "segmented", role: "group", "aria-label": "Filtrer" }, seg("all", "Tous"), seg("missed", "Manqués"))),
    h("div", { class: "scroll" },
      rows.length ? h("ul", { class: "rows" }, rows)
        : h("div", { class: "empty" }, h("p", { class: "muted" }, filter === "missed" ? "Aucun appel manqué." : "Aucun appel pour l'instant. Ouvre une discussion et touche le téléphone ou la caméra pour appeler."))),
    tabBar()));
}

// ---------- Onglet Réglages

async function renderSettings() {
  const me = state.me;
  const fp = me.pubB64.replace(/[^A-Za-z0-9]/g, "").slice(0, 32).toUpperCase().match(/.{4}/g).join(" ");
  const server = h("input", { type: "url", value: directoryUrl(), "aria-label": "Adresse du serveur annuaire" });
  const perm = pushSupported() ? Notification.permission : "unsupported";
  const notifText = { granted: "Activées sur cet appareil", denied: "Bloquées dans les réglages du téléphone", default: "Désactivées", unsupported: isIOS && !isStandalone() ? "Installe d'abord l'app sur l'écran d'accueil" : "Non disponibles sur ce navigateur" }[perm];
  const notifBtn = perm === "default" ? h("button", { class: "btn primary small", onclick: async (e) => {
    e.target.disabled = true;
    const r = await enablePush(false).catch(() => "server");
    if (r === "server") alert("Le serveur n'a pas encore les notifications activées (npm run vapid, voir le README).");
    renderSettings();
  } }, "Activer") : null;
  root.replaceChildren(h("div", { class: "screen" },
    h("header", { class: "large-head" }, h("h1", { class: "display" }, "Réglages")),
    h("div", { class: "scroll settings" },
      h("section", { class: "profile" }, avatar(me.username, "l"), h("p", { class: "title" }, me.username),
        h("p", { class: "presence" + (state.online ? " on" : "") }, h("span", { class: "dot" }), state.online ? "Connecté à l'annuaire" : "Hors ligne")),
      h("section", { class: "group" },
        h("div", { class: "item" }, svg(I.bell), h("div", { class: "item-main" }, h("span", { class: "item-title" }, "Notifications"), h("span", { class: "item-sub" }, notifText)), notifBtn || ""),
        h("div", { class: "item" }, svg(I.key), h("div", { class: "item-main" }, h("span", { class: "item-title" }, "Empreinte de ta clé"), h("span", { class: "item-sub mono" }, fp),
          h("span", { class: "item-sub" }, "Identifiant public de cet appareil. Ta clé privée ne quitte jamais ton téléphone.")))),
      h("section", { class: "group" },
        h("form", { class: "item column", onsubmit: (e) => {
          e.preventDefault();
          const v = server.value.trim();
          try { if (v && v !== CFG.directoryUrl) localStorage.setItem("directoryUrl", v); else localStorage.removeItem("directoryUrl"); } catch {}
          kvSet("directoryUrl", directoryUrl()).catch(() => {});
          if (socket) { const s = socket; socket = null; s.close(); }
          connectSocket(); renderSettings();
        } },
          h("div", { class: "item-head" }, svg(I.server), h("span", { class: "item-title" }, "Serveur annuaire")),
          server, h("div", { class: "row-actions" }, h("button", { class: "btn ghost small", type: "submit" }, "Enregistrer")))),
      h("section", { class: "group" },
        h("button", { class: "item danger", onclick: async () => {
          if (!confirm("Supprimer ton compte et tes messages de cet appareil ? Ton nom restera pris sur le serveur.")) return;
          db.close();
          await new Promise((r) => { const d = indexedDB.deleteDatabase("p2pchat"); d.onsuccess = d.onerror = d.onblocked = r; });
          location.reload();
        } }, svg(I.trash), h("span", { class: "item-title" }, "Effacer cet appareil"))),
      h("p", { class: "fineprint center" }, "P2P Chat · messages et appels chiffrés de bout en bout")),
    tabBar()));
}

// ---------- Conversation

function openChat(c) {
  state.peer = c; state.screen = "chat";
  history.pushState({ chat: c.id }, "");
  markRead(c.id).then(() => render());
  openSession(c.id);
}
function closeChat() { state.peer = null; state.screen = "home"; render(); }
window.addEventListener("popstate", () => { if (state.screen === "chat") closeChat(); });

let statusEl = null, threadEl = null;
function renderChat() {
  const c = state.peer;
  statusEl = h("span", { class: "chip" });
  threadEl = h("div", { class: "thread", role: "log", "aria-live": "polite" });
  const input = h("input", { type: "text", placeholder: "Message", autocomplete: "off", enterkeyhint: "send", "aria-label": "Message" });
  const sendBtn = h("button", { class: "send", type: "submit", "aria-label": "Envoyer", disabled: true }, svg(I.send));
  input.addEventListener("input", () => { sendBtn.disabled = !input.value.trim(); });
  const form = h("form", { class: "composer", onsubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = ""; sendBtn.disabled = true;
    sendText(c.id, t);
    input.focus();
  } }, input, sendBtn);
  root.replaceChildren(h("div", { class: "screen chat" },
    h("header", { class: "chat-head" },
      h("button", { class: "icon-btn accent", "aria-label": "Retour aux discussions", onclick: () => history.back() }, svg(I.back)),
      avatar(c.username, "s"),
      h("div", { class: "who" }, h("h1", { class: "title" }, c.username), statusEl),
      h("button", { class: "icon-btn accent", "aria-label": "Appel audio", title: "Appel audio", onclick: () => window.startCall && window.startCall(c, false) }, svg(I.phone)),
      h("button", { class: "icon-btn accent", "aria-label": "Appel vidéo", title: "Appel vidéo", onclick: () => window.startCall && window.startCall(c, true) }, svg(I.video))),
    threadEl, form));
  renderStatus();
  renderThread();
}

function renderStatus() {
  if (!statusEl || !state.peer) return;
  const s = state.online ? state.peerStatus[state.peer.id] : "me-offline";
  const [cls, text, icon] = {
    direct: ["chip on", "liaison directe · chiffré", I.link],
    connecting: ["chip", "connexion…", null],
    offline: ["chip", "hors ligne · messages remis à son retour", null],
    "me-offline": ["chip warn", "tu es hors ligne", null],
  }[s] || ["chip", "connexion…", null];
  statusEl.className = cls;
  statusEl.replaceChildren(...(icon ? [svg(icon)] : []), text);
}

let threadToken = 0;
async function renderThread() {
  if (!threadEl || !state.peer) return;
  const my = ++threadToken;
  const ms = await msgsFor(state.peer.id);
  if (my !== threadToken || !threadEl) return;
  const nodes = [h("div", { class: "line center" }, h("p", { class: "e2e" }, svg(I.lock), h("span", {}, "Messages et appels chiffrés de bout en bout. Même le serveur ne peut pas les lire.")))];
  let lastDay = null, prev = null;
  for (const m of ms) {
    const day = startOfDay(m.ts);
    if (day !== lastDay) { nodes.push(h("div", { class: "line center" }, h("p", { class: "day" }, dayLabel(m.ts)))); lastDay = day; prev = null; }
    if (m.kind === "call") {
      const video = m.video != null ? m.video : /vidéo/i.test(m.text);
      nodes.push(h("div", { class: "line center" }, h("p", { class: "call-log" }, svg(video ? I.video : I.phone), m.text + " · " + timeFmt.format(m.ts))));
      prev = null; continue;
    }
    const cont = prev && prev.outgoing === m.outgoing && m.ts - prev.ts < 180000;
    let state_ = null;
    if (m.outgoing) {
      if (!m.sent) state_ = h("span", { class: "tick wait", "aria-label": "en attente" }, svg(I.clock));
      else if (m.relayed) state_ = h("span", { class: "tick", "aria-label": "déposé, sera remis à son retour" }, svg(I.check));
      else state_ = h("span", { class: "tick ok", "aria-label": "remis" }, svg(I.checks));
    }
    nodes.push(h("div", { class: "line " + (m.outgoing ? "end" : "start") + (cont ? " cont" : "") },
      h("div", { class: "bubble " + (m.outgoing ? "out" : "in") },
        h("span", { class: "text" }, m.text),
        h("span", { class: "meta" }, h("time", {}, timeFmt.format(m.ts)), state_ || ""))));
    prev = m;
  }
  if (!ms.length) nodes.push(h("div", { class: "line center" }, h("p", { class: "day" }, "Envoie ton premier message. Il part directement vers le téléphone de " + state.peer.username + ".")));
  const atBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
  threadEl.replaceChildren(...nodes);
  if (atBottom || my <= 2) threadEl.scrollTop = threadEl.scrollHeight;
  else threadEl.scrollTop = threadEl.scrollHeight;
}

// ---------------------------------------------------------------- Démarrage

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); state.installPrompt = e; if (state.screen === "home") renderTab(true); });
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
    if (state.screen === "chat" && state.peer) markRead(state.peer.id).then(renderThread);
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

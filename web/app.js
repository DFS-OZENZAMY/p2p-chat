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

/** Ce qui part sur le réseau (chiffré). Une réaction n'a pas de « text » : l'app Android l'ignore. */
const wirePayload = (m) => m.kind === "react"
  ? { id: m.id, ts: m.ts, react: m.react || "", target: m.target }
  : { id: m.id, ts: m.ts, text: m.text };
const isOutboxItem = (m) => m.outgoing && !m.sent && (!m.kind || m.kind === "react");
/** Messages fraîchement envoyés ou reçus qui doivent déclencher un effet (pluie d'emoji). */
const freshFx = new Set();

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
    askPresence();
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
  if (m && m.type === "presence") { onPresence(m.online); return; }
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
    const pending = (await msgsFor(peerId)).filter(isOutboxItem);
    for (const m of pending) {
      const plain = enc.encode(JSON.stringify(wirePayload(m)));
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
    if (!c || c.blocked) return;
    const j = JSON.parse(dec.decode(await E2E.decrypt(await keyFor(c), bytes)));
    if (typeof j.react === "string" && j.target) {
      const t = await msgGet(String(j.target));
      if (!t || t.peerId !== peerId) return;
      t.reactions = { ...(t.reactions || {}), them: j.react || undefined };
      await msgPut(t);
      if (!batch && j.react && state.peer && state.peer.id === peerId) { const fx = EMO.effectFor(j.react); if (fx) EMO.burst(fx); }
      if (state.peer && state.peer.id === peerId) renderThread();
      return;
    }
    if (typeof j.text !== "string") return;
    if (await msgGet(String(j.id))) return;
    if (Date.now() - (Number(j.ts) || 0) < 10 * 60000) freshFx.add(String(j.id));
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
  freshFx.add(m.id);
  renderThread();
  openSession(peerId);
  flush(peerId);
  // Pas de connexion directe dans 3 s (contact hors ligne, app fermée…) : boîte aux lettres chiffrée.
  setTimeout(() => relayPending(peerId), 3000);
}

/** Réagit à un message (emoji vide = retirer). Part chiffré, par la connexion directe ou la boîte aux lettres. */
async function sendReaction(peerId, targetId, emoji) {
  const target = await msgGet(targetId);
  if (!target || target.peerId !== peerId) return;
  const mine = (target.reactions && target.reactions.me) || "";
  const next = mine === emoji ? "" : emoji;
  target.reactions = { ...(target.reactions || {}), me: next || undefined };
  await msgPut(target);
  // Une seule opération en attente par message : la plus récente remplace les autres
  for (const m of await msgsFor(peerId)) if (m.kind === "react" && m.target === targetId && !m.sent) await req("msgs", "readwrite", (st) => st.delete(m.id));
  await msgPut({ id: crypto.randomUUID(), peerId, kind: "react", react: next, target: targetId, ts: Date.now(), outgoing: true, sent: false });
  if (next) { const fx = EMO.effectFor(next); if (fx) EMO.burst(fx); }
  renderThread();
  openSession(peerId);
  flush(peerId);
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
    const pending = (await msgsFor(peerId)).filter((m) => isOutboxItem(m) && (force || now - m.ts >= 2500));
    for (const m of pending) {
      const ct = E2E.b64(await E2E.encrypt(k, enc.encode(JSON.stringify(wirePayload(m)))));
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
// Design V2 « Verre liquide » : page Figma « V2 · Verre liquide » (P2P Chat — UX/UI).

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
  bellOff: '<path d="M3 3l18 18M8.5 5.5A6 6 0 0 1 18 11v3M6 11v5l-2 2h12M10 21h4"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v7h-7M17 21v-3"/>',
  pin: '<path d="M9 4h6l-1 6 4 4H6l4-4zM12 14v7"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const MARK = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="10" width="20" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><rect x="40" y="14" width="20" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 31h16" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/></svg>';
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---------- Préférences d'affichage (thème, fond, effets)
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const darkMq = matchMedia("(prefers-color-scheme: dark)");
function applyLook() {
  const t = pref.get("theme", "system");
  const dark = t === "dark" || (t === "system" && darkMq.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.wall = pref.get("wall", "vert");
  document.documentElement.dataset.fx = pref.get("fx", "on");
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", dark ? "#0F1D21" : "#EEF3F1");
}
applyLook();
darkMq.addEventListener && darkMq.addEventListener("change", applyLook);

// ---------- Aides d'affichage
const TINTS = ["t0", "t1", "t2", "t3", "t4", "t5"];
function tintFor(name) { let x = 0; for (const ch of String(name)) x = (x * 31 + ch.codePointAt(0)) >>> 0; return TINTS[x % TINTS.length]; }
function avatar(name, size = "m", ring = false) {
  return h("span", { class: "avatar " + size + " " + tintFor(name) + (ring ? " ring" : ""), "aria-hidden": "true" }, String(name || "?")[0].toUpperCase());
}
const timeFmt = new Intl.DateTimeFormat("fr", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr", { weekday: "long", day: "numeric", month: "long" });
const shortDay = new Intl.DateTimeFormat("fr", { weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("fr", { day: "2-digit", month: "2-digit" });
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function listTime(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days === 0) return timeFmt.format(ts);
  if (days === 1) return "Hier";
  if (days < 7) return shortDay.format(ts);
  return dateFmt.format(ts);
}
function dayLabel(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  const s = dayFmt.format(ts); return s[0].toUpperCase() + s.slice(1);
}
const isDirect = (id) => { const s = sessions.get(id); return !!(s && s.isOpen); };
const isLive = (id) => isDirect(id) || state.online && state.presence.has(id);
const isMissed = (m) => m.kind === "call" && (m.status === "missed" || (!m.status && /manqué/.test(m.text)));

async function markRead(peerId) {
  for (const m of await msgsFor(peerId)) if (m.unread) { m.unread = false; await msgPut(m); }
}
let listTimer = null;
function scheduleListRefresh() { clearTimeout(listTimer); listTimer = setTimeout(() => { if (state.screen === "home") renderTab(); }, 120); }

// ---------- Présence (« En direct maintenant ») : l'annuaire dit seulement qui a l'app ouverte
state.presence = new Set();
async function askPresence() {
  if (!socket || socket.readyState !== 1) return;
  const ids = (await contactsAll()).map((c) => c.id);
  if (ids.length) socket.send(JSON.stringify({ type: "presence", ids }));
}
setInterval(() => { if (document.visibilityState === "visible" && state.screen !== "setup") askPresence(); }, 20000);
function onPresence(list) {
  const next = new Set(Array.isArray(list) ? list : []);
  const changed = next.size !== state.presence.size || [...next].some((x) => !state.presence.has(x));
  state.presence = next;
  if (!changed) return;
  if (state.screen === "home" && state.tab === "chats") scheduleListRefresh();
  if (state.screen === "chat") renderStatus();
}

// ---------- Routage
function render() {
  if (state.screen === "setup") return renderSetup();
  if (state.screen === "home") return renderTab(true);
  if (state.screen === "chat") return renderChat();
  if (state.screen === "profile") return renderProfile();
}
const renderHome = () => renderTab(true);

// ---------- Bienvenue
function renderSetup() {
  const err = h("p", { class: "error", role: "alert" });
  const name = h("input", { class: "input", type: "text", id: "username", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "20", placeholder: "ex. lina_92", required: true });
  const server = h("input", { class: "input", type: "url", id: "server", placeholder: "https://…workers.dev", value: directoryUrl() });
  const btn = h("button", { class: "btn primary block", type: "submit", disabled: true }, "Créer mon compte");
  name.addEventListener("input", () => { name.value = name.value.toLowerCase().replace(/[^a-z0-9_]/g, ""); btn.disabled = name.value.length < 3; });
  const serverField = h("div", { class: "field" }, h("label", { for: "server" }, "Adresse du serveur annuaire"), server, h("small", {}, "Fournie par la personne qui a installé le serveur."));
  const form = h("form", { class: "screen setup", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    try { const v = server.value.trim(); if (v !== (CFG.directoryUrl || "")) localStorage.setItem("directoryUrl", v); } catch {}
    btn.disabled = true; btn.textContent = "Création…";
    try { await register(name.value); kvSet("directoryUrl", directoryUrl()).catch(() => {}); state.screen = "home"; state.tab = "chats"; render(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Créer mon compte"; }
  } });
  const mark = h("div"); mark.innerHTML = MARK;
  form.append(
    h("div", { class: "setup-body" }, mark,
      h("h1", { class: "display" }, "Écris en direct, sans intermédiaire."),
      h("p", { class: "lede" }, "Tes messages et tes appels vont de ton téléphone à celui de ton contact, chiffrés. Aucun serveur ne peut les lire."),
      h("div", { class: "field" }, h("label", { for: "username" }, "Choisis ton nom d'utilisateur"), name, h("small", {}, "3 à 20 caractères : lettres, chiffres, _")),
      CFG.directoryUrl ? h("details", { class: "server" }, h("summary", {}, "Serveur annuaire"), serverField) : serverField, err),
    h("div", { class: "setup-foot" }, btn, h("p", { class: "fineprint" }, "Pas d'e-mail, pas de numéro de téléphone.")));
  root.replaceChildren(form);
  name.focus();
}

// ---------- Accueil : dock flottant (onglets en verre + bouton nouvelle discussion)
function dock() {
  const tab = (id, label, icon) => h("button", {
    class: "tab" + (state.tab === id ? " on" : ""), "aria-current": state.tab === id ? "page" : false,
    onclick: () => { if (state.tab !== id) { state.tab = id; renderTab(true); } },
  }, svg(icon), h("span", {}, label));
  return h("div", { class: "dock" },
    h("nav", { class: "tabbar glass strong", "aria-label": "Navigation" }, tab("chats", "Discussions", I.chat), tab("calls", "Appels", I.phone), tab("settings", "Réglages", I.settings)),
    state.tab === "chats" ? h("button", { class: "fab", "aria-label": "Nouvelle discussion", title: "Nouvelle discussion", onclick: openNewChat }, svg(I.plus)) : "");
}

function banners() {
  const out = [];
  if (!isStandalone()) {
    if (state.installPrompt) {
      out.push(h("div", { class: "banner glass" }, svg(I.download), h("span", {}, "Installe P2P Chat sur ton écran d'accueil."),
        h("button", { class: "btn primary small", onclick: async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; renderTab(true); } }, "Installer")));
    } else if (isIOS) {
      out.push(h("div", { class: "banner glass" }, svg(I.download), h("span", {}, "Pour installer : bouton Partager de Safari, puis « Sur l'écran d'accueil ». Les notifications ne marchent qu'une fois l'app installée.")));
    }
  }
  if (!(isIOS && !isStandalone()) && pushSupported() && Notification.permission !== "granted") {
    if (Notification.permission === "denied") out.push(h("div", { class: "banner glass warn" }, svg(I.bell), h("span", {}, "Notifications bloquées. Autorise-les dans les réglages du téléphone pour recevoir messages et appels app fermée.")));
    else {
      const b = h("button", { class: "btn primary small", onclick: async () => { b.disabled = true; const r = await enablePush(false).catch(() => "server"); if (r === "server") alert("Le serveur n'a pas encore les notifications activées (npm run vapid, voir le README)."); renderTab(true); } }, "Activer");
      out.push(h("div", { class: "banner glass" }, svg(I.bell), h("span", {}, "Reçois messages et appels même quand l'app est fermée."), b));
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
let chatBodyEl = null;
async function renderChats(full) {
  if (full || !chatBodyEl || !root.contains(chatBodyEl)) {
    chatBodyEl = h("div", { class: "chat-body", style: "display:grid;gap:14px" });
    const search = h("input", { type: "search", placeholder: "Rechercher", "aria-label": "Rechercher une discussion", value: state.search });
    search.addEventListener("input", () => { state.search = search.value; fillChats(); });
    root.replaceChildren(h("div", { class: "screen" },
      h("div", { class: "home-scroll" },
        h("div", { class: "head-row" }, h("h1", { class: "display" }, "Discussions"),
          h("button", { class: "me-btn", "aria-label": "Mes réglages", onclick: () => { state.tab = "settings"; renderTab(true); } }, avatar(state.me.username, "xs"))),
        h("label", { class: "searchbar glass" }, svg(I.search), search),
        ...banners(),
        chatBodyEl),
      dock()));
  }
  await fillChats();
  askPresence();
}

async function fillChats() {
  if (!chatBodyEl) return;
  const q = state.search.trim().toLowerCase();
  const filter = state.filter || "all";
  const contacts = await contactsAll();
  const items = await Promise.all(contacts.map(async (c) => {
    const ms = (await msgsFor(c.id)).filter((m) => m.kind !== "react");
    const last = ms[ms.length - 1];
    const lastCall = [...ms].reverse().find((m) => m.kind === "call");
    return { c, last, unread: ms.filter((m) => m.unread).length, ts: last ? last.ts : 0, missed: !!(lastCall && isMissed(lastCall)) };
  }));
  items.sort((a, b) => (b.c.pinned ? 1 : 0) - (a.c.pinned ? 1 : 0) || b.ts - a.ts || a.c.username.localeCompare(b.c.username));
  const unreadChats = items.filter((x) => x.unread).length;
  const chip = (id, label, count) => h("button", { class: "chip-f glass" + (filter === id ? " on" : ""), "aria-pressed": filter === id ? "true" : "false",
    onclick: () => { state.filter = id; fillChats(); } }, label, count ? h("span", { class: "count" }, String(count)) : "");
  const nodes = [h("div", { class: "chips", role: "group", "aria-label": "Filtrer" },
    chip("all", "Toutes"), chip("unread", "Non lues", unreadChats), chip("live", "En direct"), chip("missed", "Manqués"))];
  const live = items.filter((x) => isLive(x.c.id));
  if (live.length && filter === "all" && !q) {
    nodes.push(h("p", { class: "live-title" }, h("span", { class: "dot" }), "En direct maintenant"),
      h("div", { class: "live-row" }, ...live.map(({ c }) => h("button", { class: "live", onclick: () => openChat(c), "aria-label": c.username + ", en direct" }, avatar(c.username, "live-a", true), h("span", {}, c.username)))));
  }
  let shown = items.filter((x) => !q || x.c.username.includes(q));
  if (filter === "unread") shown = shown.filter((x) => x.unread);
  if (filter === "live") shown = shown.filter((x) => isLive(x.c.id));
  if (filter === "missed") shown = shown.filter((x) => x.missed);
  if (!items.length) {
    nodes.push(h("div", { class: "card glass strong empty" }, h("p", { class: "title" }, "Aucune discussion"),
      h("p", { class: "muted" }, "Ajoute un contact avec son nom d'utilisateur. Il doit avoir créé son compte dans P2P Chat, sur Android ou sur le web."),
      h("button", { class: "btn primary", onclick: openNewChat }, "Ajouter un contact")));
  } else if (!shown.length) {
    nodes.push(h("div", { class: "card glass empty" }, h("p", { class: "muted" }, q ? "Aucun contact ne correspond à « " + q + " »." : { unread: "Tout est lu.", live: "Personne n'a l'app ouverte en ce moment.", missed: "Aucun appel manqué." }[filter] || "Rien ici.")));
  } else {
    nodes.push(h("ul", { class: "rows card glass strong", "aria-label": "Discussions" }, ...shown.map(({ c, last, unread }) => {
      let preview = "Aucun message", danger = false;
      if (last) { preview = (last.kind === "call" ? "" : last.outgoing ? "Toi : " : "") + last.text; danger = isMissed(last); }
      if (c.blocked) preview = "Bloqué";
      return h("li", {}, h("button", { class: "row", onclick: () => openChat(c) },
        avatar(c.username, "m", isLive(c.id)),
        h("span", { class: "row-main" },
          h("span", { class: "row-top" }, h("span", { class: "row-name" }, c.username),
            last ? h("span", { class: "row-time" + (unread ? " accent" : "") }, listTime(last.ts)) : ""),
          h("span", { class: "row-bottom" }, h("span", { class: "row-preview" + (danger ? " danger" : "") }, preview),
            c.muted ? h("span", { class: "pin", title: "Notifications coupées" }, svg(I.bellOff)) : "",
            c.pinned ? h("span", { class: "pin", title: "Épinglée" }, "📌") : "",
            unread ? h("span", { class: "badge", "aria-label": unread + " non lus" }, String(unread)) : ""))));
    })));
  }
  chatBodyEl.replaceChildren(...nodes);
}

function openNewChat() {
  const err = h("p", { class: "error", role: "alert" });
  const input = h("input", { class: "input", type: "text", placeholder: "Nom d'utilisateur", autocapitalize: "none", autocomplete: "off", spellcheck: "false", "aria-label": "Nom d'utilisateur du contact" });
  const dlg = h("dialog", { class: "sheet" });
  const close = () => { dlg.close(); dlg.remove(); };
  const go = h("button", { class: "btn primary", type: "submit" }, "Ouvrir la discussion");
  dlg.append(h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; go.disabled = true;
    try { const c = await addContact(input.value); close(); openChat(c); } catch (x) { err.textContent = x.message; go.disabled = false; }
  } }, h("h2", { class: "title" }, "Nouvelle discussion"), h("p", { class: "muted" }, "Écris le nom d'utilisateur de ton contact."), input, err,
    h("div", { class: "row-actions" }, h("button", { class: "btn ghost", type: "button", onclick: close }, "Annuler"), go)));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal(); input.focus();
}

// ---------- Onglet Appels
async function renderCalls() {
  const filter = state.callFilter || "all";
  const logs = [];
  for (const c of await contactsAll()) for (const m of await msgsFor(c.id)) if (m.kind === "call") logs.push({ c, m });
  logs.sort((a, b) => b.m.ts - a.m.ts);
  const shown = filter === "missed" ? logs.filter((x) => isMissed(x.m)) : logs;
  const seg = (id, label) => h("button", { class: "seg" + (filter === id ? " on" : ""), "aria-pressed": filter === id ? "true" : "false", onclick: () => { state.callFilter = id; renderCalls(); } }, label);
  const rows = shown.map(({ c, m }) => {
    const video = m.video != null ? m.video : /vidéo/i.test(m.text);
    const miss = isMissed(m);
    let detail = video ? "Vidéo" : "Audio";
    if (m.duration) detail += " · " + m.duration; else if (miss) detail += " · manqué"; else if (m.status === "declined") detail += " · refusé"; else if (m.status === "noanswer") detail += " · sans réponse";
    return h("li", { class: "row static" }, avatar(c.username, "s"),
      h("button", { class: "row-main link", onclick: () => openChat(c) },
        h("span", { class: "row-name" + (miss ? " danger" : "") }, c.username),
        h("span", { class: "row-detail" }, svg(miss ? I.phoneMissed : m.outgoing ? I.phoneOut : I.phoneIn, miss ? "danger" : ""), detail + " · " + listTime(m.ts))),
      h("button", { class: "round-btn tint", "aria-label": (video ? "Appel vidéo" : "Appel audio") + " à " + c.username, onclick: () => window.startCall && window.startCall(c, video) }, svg(video ? I.video : I.phone)));
  });
  root.replaceChildren(h("div", { class: "screen" },
    h("div", { class: "home-scroll" }, h("h1", { class: "display" }, "Appels"),
      h("div", { class: "segmented", role: "group", "aria-label": "Filtrer" }, seg("all", "Tous"), seg("missed", "Manqués")),
      rows.length ? h("ul", { class: "rows card glass strong" }, rows)
        : h("div", { class: "card glass empty" }, h("p", { class: "muted" }, filter === "missed" ? "Aucun appel manqué." : "Aucun appel pour l'instant. Ouvre une discussion et touche le téléphone ou la caméra."))),
    dock()));
}

// ---------- Onglet Réglages
async function renderSettings() {
  const me = state.me;
  const theme = pref.get("theme", "system"), wall = pref.get("wall", "vert"), fx = pref.get("fx", "on") !== "off";
  const perm = pushSupported() ? Notification.permission : "unsupported";
  const segT = (id, label) => h("button", { class: "seg" + (theme === id ? " on" : ""), "aria-pressed": theme === id ? "true" : "false", onclick: () => { pref.set("theme", id); applyLook(); renderSettings(); } }, label);
  const swatch = (id, label) => h("button", { class: "wall-sw " + id, "aria-label": "Fond " + label, "aria-pressed": wall === id ? "true" : "false", title: label, onclick: () => { pref.set("wall", id); applyLook(); renderSettings(); } });
  const sw = (on, label, onclick, disabled) => h("button", { class: "switch", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label, disabled, onclick });
  const notifSub = { granted: "Activées sur cet appareil", denied: "Bloquées dans les réglages du téléphone", default: "Désactivées", unsupported: isIOS && !isStandalone() ? "Installe d'abord l'app sur l'écran d'accueil" : "Non disponibles sur ce navigateur" }[perm];
  const item = (icon, title, sub, right, opts = {}) => h(opts.onclick ? "button" : "div", { class: "item" + (opts.danger ? " danger" : ""), onclick: opts.onclick },
    h("span", { class: "item-ic" }, svg(icon)), h("span", { class: "item-main" }, h("span", { class: "item-title" }, title), sub ? h("span", { class: "item-sub" }, sub) : ""), right || "");
  root.replaceChildren(h("div", { class: "screen" },
    h("div", { class: "home-scroll" }, h("h1", { class: "display" }, "Réglages"),
      h("div", { class: "profile-card glass strong" }, avatar(me.username, "m", state.online),
        h("span", { class: "item-main" }, h("span", { class: "title" }, me.username), h("span", { class: "item-sub" }, (state.online ? "Connecté" : "Hors ligne") + " · clé " + fingerprint(me.pubB64))),
        h("button", { class: "round-btn tint", "aria-label": "Mon code de vérification", onclick: showMyCode }, svg(I.qr))),
      h("p", { class: "section-label" }, "Apparence"),
      h("div", { class: "card-pad glass strong" },
        h("div", { class: "segmented", role: "group", "aria-label": "Thème" }, segT("system", "Système"), segT("light", "Clair"), segT("dark", "Sombre")),
        h("span", { class: "item-title" }, "Fond de discussion"),
        h("div", { class: "walls" }, swatch("vert", "Vert"), swatch("ocean", "Océan"), swatch("prune", "Prune"), swatch("sable", "Sable"), swatch("nuit", "Nuit"))),
      h("p", { class: "section-label" }, "Notifications et effets"),
      h("div", { class: "list-card glass strong" },
        item(I.bell, "Notifications", notifSub, perm === "default" ? sw(false, "Activer les notifications", async (e) => { e.currentTarget.disabled = true; const r = await enablePush(false).catch(() => "server"); if (r === "server") alert("Le serveur n'a pas encore les notifications activées (npm run vapid, voir le README)."); renderSettings(); }) : sw(perm === "granted", "Notifications", null, true)),
        item(I.sparkle, "Effets et animations", "Pluies d'emoji, emoji animés", sw(fx, "Effets et animations", () => { pref.set("fx", fx ? "off" : "on"); renderSettings(); }))),
      h("p", { class: "section-label" }, "Confidentialité"),
      h("div", { class: "list-card glass strong" },
        item(I.shield, "Mon code de vérification", "À faire scanner par tes contacts", null, { onclick: showMyCode }),
        item(I.server, "Serveur annuaire", directoryUrl().replace(/^https?:\/\//, ""), null, { onclick: editServer })),
      h("div", { class: "list-card glass strong" }, item(I.trash, "Effacer cet appareil", "Supprime ton compte et tes messages de ce téléphone", null, { danger: true, onclick: wipeDevice })),
      h("p", { class: "fineprint center" }, "P2P Chat · messages et appels chiffrés de bout en bout")),
    dock()));
}

function editServer() {
  const input = h("input", { class: "input", type: "url", value: directoryUrl(), "aria-label": "Adresse du serveur annuaire" });
  const dlg = h("dialog", { class: "sheet" });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(h("form", { class: "stack", onsubmit: (e) => {
    e.preventDefault(); const v = input.value.trim();
    try { if (v && v !== CFG.directoryUrl) localStorage.setItem("directoryUrl", v); else localStorage.removeItem("directoryUrl"); } catch {}
    kvSet("directoryUrl", directoryUrl()).catch(() => {});
    if (socket) { const s = socket; socket = null; s.close(); }
    connectSocket(); close(); renderSettings();
  } }, h("h2", { class: "title" }, "Serveur annuaire"), input, h("div", { class: "row-actions" }, h("button", { class: "btn ghost", type: "button", onclick: close }, "Annuler"), h("button", { class: "btn primary", type: "submit" }, "Enregistrer"))));
  document.body.append(dlg); dlg.showModal();
}
async function wipeDevice() {
  if (!confirm("Supprimer ton compte et tes messages de cet appareil ? Ton nom restera pris sur le serveur.")) return;
  db.close();
  await new Promise((r) => { const d = indexedDB.deleteDatabase("p2pchat"); d.onsuccess = d.onerror = d.onblocked = r; });
  location.reload();
}

// ---------- Vérification du chiffrement (numéro de sécurité + QR, comme Signal)
const fingerprint = (b64) => b64.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase().match(/.{4}/g).join(" ");
async function safetyNumber(a, b) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("p2p-chat-safety-v1:" + [a, b].sort().join(":"))));
  const groups = [];
  for (let i = 0; i < 9; i++) { const v = ((hash[i * 3] << 16) | (hash[i * 3 + 1] << 8) | hash[i * 3 + 2]) % 100000; groups.push(String(v).padStart(5, "0")); }
  return [groups.slice(0, 3).join(" "), groups.slice(3, 6).join(" "), groups.slice(6, 9).join(" ")];
}
const myCodePayload = () => "p2pchat:1:" + state.me.id + ":" + state.me.pubB64;
function loadScript(src) {
  return new Promise((res, rej) => { if (document.querySelector('script[src="' + src + '"]')) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
}
async function qrSvg(text) {
  await loadScript("vendor/qrcode.min.js");
  const q = self.qrcode(0, "M"); q.addData(text); q.make();
  const box = h("div", { class: "qr-box" }); box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  return box;
}
async function showMyCode() {
  const dlg = h("dialog", { class: "sheet" });
  const close = () => { dlg.close(); dlg.remove(); };
  const qr = await qrSvg(myCodePayload()); qr.style.width = qr.style.height = "220px"; qr.style.margin = "0 auto";
  dlg.append(h("div", { class: "stack" }, h("h2", { class: "title" }, "Mon code"), h("p", { class: "muted" }, "Fais scanner ce code par ton contact depuis sa fiche contact pour vérifier que vos échanges ne sont pas interceptés."),
    qr, h("p", { class: "center mono" }, fingerprint(state.me.pubB64)), h("div", { class: "row-actions" }, h("button", { class: "btn primary", onclick: close }, "Fermer"))));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
}
async function scanCode(contact) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
  catch { alert("Impossible d'ouvrir la caméra."); return; }
  const video = h("video", { playsinline: true, autoplay: true, muted: true }); video.muted = true; video.srcObject = stream;
  const msg = h("p", {}, "Vise le code affiché sur le téléphone de " + contact.username + ".");
  let done = false;
  const stop = () => { done = true; for (const t of stream.getTracks()) t.stop(); ui.remove(); };
  const ui = h("div", { class: "scanner", role: "dialog", "aria-label": "Scanner le code" }, video, h("div", { class: "frame" }),
    h("div", { class: "bar" }, msg, h("button", { class: "btn", onclick: stop }, "Annuler")));
  document.body.append(ui);
  const detector = "BarcodeDetector" in self ? new self.BarcodeDetector({ formats: ["qr_code"] }) : null;
  if (!detector) await loadScript("vendor/jsQR.min.js").catch(() => {});
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
  const check = async (text) => {
    const m = /^p2pchat:1:([^:]+):(.+)$/.exec(text || "");
    if (!m) return false;
    stop();
    if (m[1] === contact.id && m[2] === contact.publicKey) {
      contact.verified = contact.publicKey; await contactPut(contact);
      if (navigator.vibrate) try { navigator.vibrate([20, 60, 20]); } catch {}
      alert("✅ Vérifié : vos échanges avec " + contact.username + " sont bien chiffrés de bout en bout, sans intermédiaire.");
    } else {
      alert("⚠️ Ce code ne correspond pas à " + contact.username + ". Ne lui envoie rien de sensible et vérifie avec lui de vive voix.");
    }
    render();
    return true;
  };
  const tick = async () => {
    if (done) return;
    if (video.readyState >= 2) {
      try {
        if (detector) { const r = await detector.detect(video); if (r[0] && await check(r[0].rawValue)) return; }
        else if (self.jsQR) {
          const w = canvas.width = Math.min(640, video.videoWidth), hh = canvas.height = Math.round(video.videoHeight * w / video.videoWidth);
          ctx.drawImage(video, 0, 0, w, hh); const r = self.jsQR(ctx.getImageData(0, 0, w, hh).data, w, hh);
          if (r && await check(r.data)) return;
        }
      } catch {}
    }
    setTimeout(tick, 220);
  };
  tick();
}

// ---------- Fiche contact
async function openProfile(c) {
  state.peer = c; state.screen = "profile";
  history.pushState({ profile: c.id }, "");
  render();
}
async function renderProfile() {
  const c = await contactGet(state.peer.id) || state.peer; state.peer = c;
  const live = isLive(c.id);
  const verified = c.verified && c.verified === c.publicKey;
  const lines = await safetyNumber(state.me.pubB64, c.publicKey);
  const qr = await qrSvg(myCodePayload());
  const sw = (on, label, onclick) => h("button", { class: "switch", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label, onclick });
  const save = async (patch) => { Object.assign(c, patch); await contactPut(c); renderProfile(); };
  root.replaceChildren(h("div", { class: "screen" },
    h("div", { class: "profile-scroll" },
      h("div", { class: "profile-nav" }, h("button", { class: "round-btn", "aria-label": "Retour", onclick: () => history.back() }, svg(I.back))),
      h("div", { class: "profile-id" }, avatar(c.username, "l", live), h("h1", { class: "display", style: "font-size:30px;line-height:34px" }, c.username),
        verified ? h("span", { class: "status-chip ok" }, svg(I.shield), "Vérifié") : h("span", { class: "status-chip" + (live ? " on" : "") }, svg(I.link), isDirect(c.id) ? "liaison directe · chiffré" : live ? "en ligne · chiffré" : "chiffré de bout en bout")),
      h("div", { class: "actions3" },
        h("button", { class: "action glass strong", onclick: () => openChat(c, true) }, svg(I.chat), "Message"),
        h("button", { class: "action glass strong", onclick: () => window.startCall && window.startCall(c, false) }, svg(I.phone), "Audio"),
        h("button", { class: "action glass strong", onclick: () => window.startCall && window.startCall(c, true) }, svg(I.video), "Vidéo")),
      h("div", { class: "card-pad glass strong" },
        h("div", { class: "verify-head" }, svg(verified ? I.shield : I.lock), verified ? "Chiffrement vérifié" : "Vérifier le chiffrement"),
        h("div", { class: "verify-body" }, qr, h("div", { class: "safety mono" }, ...lines.map((l) => h("span", {}, l)))),
        h("p", { class: "fineprint" }, "Comparez ce numéro de vive voix : il doit être identique sur vos deux téléphones. Ou scannez le code affiché sur le sien (Réglages > Mon code). Le QR ci-dessus est le tien."),
        h("button", { class: "btn dark block", onclick: () => scanCode(c) }, verified ? "Scanner à nouveau" : "Scanner son code")),
      h("div", { class: "list-card glass strong" },
        h("div", { class: "item" }, h("span", { class: "item-ic" }, svg(I.pin)), h("span", { class: "item-main" }, h("span", { class: "item-title" }, "Épingler la discussion")), sw(!!c.pinned, "Épingler", () => save({ pinned: !c.pinned }))),
        h("div", { class: "item" }, h("span", { class: "item-ic" }, svg(c.muted ? I.bellOff : I.bell)), h("span", { class: "item-main" }, h("span", { class: "item-title" }, "Notifications"), h("span", { class: "item-sub" }, c.muted ? "Silencieuses" : "Avec son")), sw(!c.muted, "Notifications avec son", () => save({ muted: !c.muted })))),
      h("div", { class: "list-card glass strong" },
        h("button", { class: "item danger", onclick: () => { if (c.blocked || confirm("Bloquer " + c.username + " ? Tu ne recevras plus ses messages ni ses appels.")) save({ blocked: !c.blocked }); } },
          h("span", { class: "item-ic" }, svg(I.block)), h("span", { class: "item-main" }, h("span", { class: "item-title" }, (c.blocked ? "Débloquer " : "Bloquer ") + c.username))),
        h("button", { class: "item danger", onclick: async () => {
          if (!confirm("Supprimer la discussion avec " + c.username + " de cet appareil ?")) return;
          for (const m of await msgsFor(c.id)) await req("msgs", "readwrite", (st) => st.delete(m.id));
          await req("contacts", "readwrite", (st) => st.delete(c.id));
          state.peer = null; state.screen = "home"; state.tab = "chats"; history.replaceState(null, ""); render();
        } }, h("span", { class: "item-ic" }, svg(I.trash)), h("span", { class: "item-main" }, h("span", { class: "item-title" }, "Supprimer la discussion")))))));
}

// ---------- Conversation
function openChat(c, replace) {
  state.peer = c; state.screen = "chat";
  if (replace) history.replaceState({ chat: c.id }, ""); else history.pushState({ chat: c.id }, "");
  markRead(c.id).then(() => render());
  openSession(c.id);
}
function closeChat() { state.peer = null; state.screen = "home"; render(); }
window.addEventListener("popstate", () => {
  if (state.screen === "profile" && history.state && history.state.chat) { state.screen = "chat"; render(); return; }
  if (state.screen === "chat" || state.screen === "profile") closeChat();
});

let statusEl = null, threadEl = null;
function renderChat() {
  const c = state.peer;
  statusEl = h("span", { class: "status" });
  threadEl = h("div", { class: "thread", role: "log", "aria-live": "polite" });
  const input = h("input", { type: "text", placeholder: c.blocked ? "Contact bloqué" : "Message", autocomplete: "off", enterkeyhint: "send", "aria-label": "Message", disabled: !!c.blocked });
  const sendBtn = h("button", { class: "send", type: "submit", "aria-label": "Envoyer", disabled: true }, svg(I.send));
  const sync = () => { sendBtn.disabled = !input.value.trim(); };
  input.addEventListener("input", sync);
  let panel = null;
  const emojiBtn = h("button", { class: "icon-btn emoji-toggle", type: "button", "aria-label": "Emoji", "aria-expanded": "false" }, svg(I.smile));
  const closePanel = () => { if (!panel) return; panel.el.remove(); panel = null; chatEl.classList.remove("panel-open"); emojiBtn.replaceChildren(svg(I.smile)); emojiBtn.setAttribute("aria-label", "Emoji"); emojiBtn.setAttribute("aria-expanded", "false"); };
  emojiBtn.addEventListener("click", () => {
    if (panel) { closePanel(); input.focus(); return; }
    input.blur();
    panel = EMO.picker((e) => { const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? input.value.length; input.setRangeText(e, a, b, "end"); sync(); });
    chatEl.classList.add("panel-open"); chatEl.append(panel.el);
    emojiBtn.replaceChildren(svg(I.keyboard)); emojiBtn.setAttribute("aria-label", "Clavier"); emojiBtn.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => { threadEl.scrollTop = threadEl.scrollHeight; });
  });
  input.addEventListener("focus", closePanel);
  const form = h("form", { class: "composer", onsubmit: (e) => {
    e.preventDefault(); const t = input.value.trim(); if (!t) return;
    input.value = ""; sync(); sendText(c.id, t); if (!panel) input.focus();
  } }, h("div", { class: "field-pill glass strong" }, emojiBtn, input), sendBtn);
  const chatEl = h("div", { class: "screen chat wall" });
  chatEl.append(threadEl,
    h("header", { class: "chat-head glass strong" },
      h("button", { class: "icon-btn", "aria-label": "Retour aux discussions", onclick: () => history.back() }, svg(I.back)),
      h("button", { class: "who", "aria-label": "Fiche de " + c.username, onclick: () => openProfile(c) }, avatar(c.username, "s", isLive(c.id)),
        h("span", { class: "who-text" }, h("span", { class: "title" }, c.username), statusEl)),
      h("button", { class: "round-btn tint", "aria-label": "Appel audio", title: "Appel audio", onclick: () => window.startCall && window.startCall(c, false) }, svg(I.phone)),
      h("button", { class: "round-btn tint", "aria-label": "Appel vidéo", title: "Appel vidéo", onclick: () => window.startCall && window.startCall(c, true) }, svg(I.video))),
    form);
  root.replaceChildren(chatEl);
  renderStatus();
  renderThread();
}

function renderStatus() {
  if (!statusEl || !state.peer) return;
  const id = state.peer.id;
  let s = state.online ? state.peerStatus[id] : "me-offline";
  if (s !== "direct" && s !== "me-offline" && state.presence.has(id)) s = "online";
  const [cls, text, icon] = {
    direct: ["status on", "liaison directe · chiffré", I.link],
    online: ["status on", "en ligne · connexion…", null],
    connecting: ["status", "connexion…", null],
    offline: ["status", "hors ligne · remis à son retour", null],
    "me-offline": ["status warn", "tu es hors ligne", null],
  }[s] || ["status", "connexion…", null];
  statusEl.className = cls;
  statusEl.replaceChildren(...(icon ? [svg(icon)] : []), text);
}

let threadToken = 0;
async function renderThread() {
  if (!threadEl || !state.peer) return;
  const my = ++threadToken;
  const all = await msgsFor(state.peer.id);
  if (my !== threadToken || !threadEl) return;
  const ms = all.filter((m) => m.kind !== "react");
  const nodes = [h("div", { class: "line center" }, h("p", { class: "pill e2e glass" }, svg(I.lock), h("span", {}, "Messages et appels chiffrés de bout en bout. Même le serveur ne peut pas les lire.")))];
  const same = (a, b) => a && b && !a.kind && !b.kind && a.outgoing === b.outgoing && Math.abs(a.ts - b.ts) < 180000 && startOfDay(a.ts) === startOfDay(b.ts);
  let lastDay = null;
  ms.forEach((m, i) => {
    const day = startOfDay(m.ts);
    if (day !== lastDay) { nodes.push(h("div", { class: "line center" }, h("p", { class: "pill glass" }, dayLabel(m.ts)))); lastDay = day; }
    if (m.kind === "call") {
      const video = m.video != null ? m.video : /vidéo/i.test(m.text);
      nodes.push(h("div", { class: "line center" }, h("p", { class: "pill glass" }, svg(isMissed(m) ? I.phoneMissed : video ? I.video : I.phone), m.text + " · " + timeFmt.format(m.ts))));
      return;
    }
    const cont = same(ms[i - 1], m), next = same(m, ms[i + 1]);
    let tick = null;
    if (m.outgoing) {
      if (!m.sent) tick = h("span", { class: "tick wait", "aria-label": "en attente" }, svg(I.clock));
      else if (m.relayed) tick = h("span", { class: "tick", "aria-label": "déposé, sera remis à son retour" }, svg(I.check));
      else tick = h("span", { class: "tick ok", "aria-label": "remis" }, svg(I.checks));
    }
    const jumbo = EMO.jumboCount(m.text);
    const body = jumbo
      ? h("span", { class: "text jumbo j" + jumbo }, ...EMO.graphemes(m.text.trim()).filter((g) => g.trim()).map((g, k) => h("span", { class: "je a-" + EMO.animFor(g), style: "animation-delay:" + (k * 0.12) + "s" }, g)))
      : h("span", { class: "text" }, m.text);
    const r = m.reactions || {};
    const reacts = [r.me, r.them].filter(Boolean);
    const reactEl = reacts.length ? h("button", { class: "reacts glass strong", type: "button", "aria-label": "Réactions : " + reacts.join(" "), onclick: (e) => { e.stopPropagation(); openReactBar(m, e.currentTarget.closest(".bubble")); } },
      ...(r.me && r.me === r.them ? [h("span", {}, r.me), h("small", {}, "2")] : reacts.map((x) => h("span", {}, x)))) : "";
    const bubble = h("div", { class: "bubble " + (m.outgoing ? "out" : "in") + (jumbo ? " bare" : "") + (reacts.length ? " has-reacts" : ""), "data-id": m.id, tabindex: "0" },
      body, h("span", { class: "meta" }, h("time", {}, timeFmt.format(m.ts)), tick || ""), reactEl);
    attachGestures(bubble, m);
    nodes.push(h("div", { class: "line " + (m.outgoing ? "end" : "start") + (cont ? " cont" : "") + (next ? " next" : "") }, bubble));
  });
  if (!ms.length) nodes.push(h("div", { class: "line center" }, h("p", { class: "pill glass" }, "Envoie ton premier message à " + state.peer.username + " 👋")));
  threadEl.replaceChildren(...nodes);
  for (const m of ms) if (freshFx.has(m.id)) {
    freshFx.delete(m.id);
    if (document.visibilityState === "visible") { const fx = EMO.effectFor(m.text); if (fx) { EMO.burst(fx); break; } }
  }
  threadEl.scrollTop = threadEl.scrollHeight;
}

// ---------- Réactions : appui long ou double-tap sur une bulle

function attachGestures(bubble, m) {
  let timer = null, startX = 0, startY = 0, lastTap = 0;
  bubble.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".reacts")) return;
    startX = e.clientX; startY = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (navigator.vibrate) try { navigator.vibrate(12); } catch {} openReactBar(m, bubble); }, 430);
  });
  bubble.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) { clearTimeout(timer); timer = null; } });
  const cancel = () => { clearTimeout(timer); timer = null; };
  bubble.addEventListener("pointercancel", cancel);
  bubble.addEventListener("pointerup", (e) => {
    if (!timer) return; // l'appui long a déjà ouvert la barre
    cancel();
    if (e.target.closest(".reacts")) return;
    const now = Date.now();
    if (now - lastTap < 320) { lastTap = 0; sendReaction(m.peerId, m.id, "❤️"); popHeart(bubble); }
    else lastTap = now;
  });
  bubble.addEventListener("contextmenu", (e) => { e.preventDefault(); openReactBar(m, bubble); });
  bubble.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openReactBar(m, bubble); } });
}

function popHeart(bubble) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hrt = h("span", { class: "pop-heart", "aria-hidden": "true" }, "❤️");
  bubble.append(hrt);
  setTimeout(() => hrt.remove(), 900);
}

let reactBar = null;
function closeReactBar() { if (reactBar) { reactBar.remove(); reactBar = null; } }
function openReactBar(m, bubble) {
  closeReactBar();
  const mine = (m.reactions && m.reactions.me) || "";
  const pick = (e) => { closeReactBar(); sendReaction(m.peerId, m.id, e); };
  const more = h("button", { class: "rb-more", type: "button", "aria-label": "Plus d'emoji" }, svg(I.plus));
  const bar = h("div", { class: "react-bar", role: "dialog", "aria-label": "Réagir au message" },
    h("div", { class: "rb-row" },
      ...EMO.QUICK.map((e, i) => h("button", { class: "rb-emoji" + (mine === e ? " on" : ""), type: "button", style: "animation-delay:" + (i * 0.03) + "s", "aria-label": "Réagir " + e, onclick: () => pick(e) }, e)),
      more),
    h("div", { class: "rb-actions" },
      h("button", { type: "button", onclick: async () => { closeReactBar(); try { await navigator.clipboard.writeText(m.text); } catch {} } }, svg(I.copy), "Copier"),
      mine ? h("button", { type: "button", onclick: () => pick(mine) }, "Retirer " + mine) : ""));
  more.addEventListener("click", () => {
    const p = EMO.picker((e) => pick(e), { compact: true });
    bar.classList.add("expanded");
    bar.querySelector(".rb-row").replaceWith(p.el);
  });
  const veil = h("div", { class: "react-veil", onclick: closeReactBar });
  reactBar = h("div", { class: "react-layer" }, veil, bar);
  document.body.append(reactBar);
  // Placer la barre au-dessus (ou au-dessous) de la bulle
  const rect = bubble.getBoundingClientRect();
  const bw = Math.min(340, innerWidth - 16);
  bar.style.width = bw + "px";
  let left = m.outgoing ? rect.right - bw : rect.left;
  left = Math.max(8, Math.min(left, innerWidth - bw - 8));
  bar.style.left = left + "px";
  const above = rect.top > 150;
  bar.style.top = (above ? Math.max(8, rect.top - 118) : Math.min(innerHeight - 130, rect.bottom + 8)) + "px";
  bubble.classList.add("lifted");
  const obs = new MutationObserver(() => { if (!document.body.contains(reactBar)) { bubble.classList.remove("lifted"); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
  const onKey = (e) => { if (e.key === "Escape") { closeReactBar(); removeEventListener("keydown", onKey); } };
  addEventListener("keydown", onKey);
  bar.querySelector("button").focus({ preventScroll: true });
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

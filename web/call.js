// Appels audio et vidéo, de téléphone à téléphone (WebRTC).
// - Une connexion WebRTC dédiée par appel, distincte de celle du chat.
// - L'audio/vidéo est chiffré par WebRTC (DTLS-SRTP). L'offre et la réponse (SDP), qui contiennent
//   l'empreinte DTLS, sont chiffrées avec la clé E2E du contact : l'annuaire ne peut pas s'intercaler.
// - Signaux : call-offer, call-answer, call-ice, call-end, call-busy. Les clients qui ne les
//   connaissent pas (app Android actuelle) les ignorent : l'appel sonne alors dans le vide.
"use strict";

const RING_TIMEOUT = 45000;
let call = null;

const ICON_PHONE = '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>';
const ICON_VIDEO = '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>';
const ICON_MIC = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>';
const ICON_MIC_OFF = '<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>';
const ICON_CAM_OFF = '<path d="M3 3l18 18M16 16H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M10 6h4a2 2 0 0 1 2 2v3l5-3v10"/>';
const ICON_FLIP = '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9 13a3 3 0 0 1 5.2-2M15 13a3 3 0 0 1-5.2 2M14 9v2h-2M10 17v-2h2"/>';
const ICON_HANGUP = '<path d="M3 15c5-5 13-5 18 0l-2 3-4-1v-3a9 9 0 0 0-6 0v3l-4 1z"/>';

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

async function sealSdp(contact, sdp) {
  return E2E.b64(await E2E.encrypt(await keyFor(contact), new TextEncoder().encode(sdp)));
}
async function openSdp(contact, payload) {
  return new TextDecoder().decode(await E2E.decrypt(await keyFor(contact), E2E.unb64(payload)));
}

class Call {
  constructor(contact, video, outgoing, id) {
    this.contact = contact;
    this.peerId = contact.id;
    this.video = video;
    this.outgoing = outgoing;
    this.id = id || crypto.randomUUID();
    this.state = outgoing ? "calling" : "ringing"; // calling | ringing | connecting | active | ended
    this.pc = null;
    this.local = null;
    this.remote = new MediaStream();
    this.pendingIce = [];
    this.remoteSet = false;
    this.startedAt = 0;
    this.muted = false;
    this.camOff = false;
    this.facing = "user";
    this.timer = setTimeout(() => {
      if (this.state === "calling" || this.state === "ringing") this.end(this.outgoing ? "Pas de réponse" : null, true);
    }, RING_TIMEOUT);
  }

  signal(m) { sendSignal(this.peerId, { ...m, callId: this.id }); }

  async media() {
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: this.video ? { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  }

  makePc() {
    const pc = (this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }));
    for (const t of this.local.getTracks()) pc.addTrack(t, this.local);
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (c && c.candidate) this.signal({ type: "call-ice", sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, candidate: c.candidate });
    };
    pc.ontrack = (e) => {
      if (!this.remote.getTracks().includes(e.track)) this.remote.addTrack(e.track);
      renderCall();
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected" && this.state !== "active") {
        this.state = "active";
        this.startedAt = Date.now();
        clearTimeout(this.timer);
        renderCall();
      } else if (s === "failed") {
        this.end("Connexion perdue", true);
      }
    };
  }

  remoteReady() {
    this.remoteSet = true;
    for (const c of this.pendingIce) this.pc.addIceCandidate(c).catch(() => {});
    this.pendingIce = [];
  }

  addIce(m) {
    const c = { candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex };
    if (this.pc && this.remoteSet) this.pc.addIceCandidate(c).catch(() => {});
    else this.pendingIce.push(c);
  }

  toggleMute() {
    this.muted = !this.muted;
    for (const t of this.local.getAudioTracks()) t.enabled = !this.muted;
    renderCall();
  }

  toggleCam() {
    this.camOff = !this.camOff;
    for (const t of this.local.getVideoTracks()) t.enabled = !this.camOff;
    renderCall();
  }

  async flip() {
    const next = this.facing === "user" ? "environment" : "user";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
      const track = s.getVideoTracks()[0];
      const sender = this.pc && this.pc.getSenders().find((x) => x.track && x.track.kind === "video");
      if (sender) await sender.replaceTrack(track);
      for (const t of this.local.getVideoTracks()) { this.local.removeTrack(t); t.stop(); }
      track.enabled = !this.camOff;
      this.local.addTrack(track);
      this.facing = next;
      renderCall();
    } catch { /* une seule caméra */ }
  }

  /** Termine l'appel. notify = prévenir l'autre ; note = texte affiché brièvement. */
  end(note, notify, reason) {
    if (this.state === "ended") return;
    const wasActive = this.state === "active";
    if (reason === "declined") this.declined = true;
    this.state = "ended";
    clearTimeout(this.timer);
    if (notify) this.signal({ type: "call-end", reason: reason || "hangup" });
    try { this.pc && this.pc.close(); } catch {}
    if (this.local) for (const t of this.local.getTracks()) t.stop();
    logCall(this, wasActive);
    if (call === this) call = null;
    renderCall(note);
  }
}

/** Trace l'appel dans la conversation (local uniquement, jamais envoyé). */
async function logCall(c, wasActive) {
  const kind = c.video ? "Appel vidéo" : "Appel audio";
  let text;
  if (wasActive) text = kind + " · " + fmtDuration(Date.now() - c.startedAt);
  else if (c.declined) text = kind + " refusé";
  else if (c.outgoing) text = kind + " sans réponse";
  else text = kind + " manqué";
  await msgPut({ id: "call-" + c.id, peerId: c.peerId, text, ts: Date.now(), outgoing: c.outgoing, sent: true, kind: "call" });
  if (state.peer && state.peer.id === c.peerId) renderThread();
  else if (state.screen === "home") renderHome();
}

async function startCall(contact, video) {
  if (call) return;
  if (!socket || socket.readyState !== 1) { alert("Tu es hors ligne : impossible d'appeler pour l'instant."); return; }
  const c = (call = new Call(contact, video, true));
  renderCall();
  try {
    await c.media();
  } catch (e) {
    c.end(video ? "Accès à la caméra ou au micro refusé" : "Accès au micro refusé", false);
    return;
  }
  if (c.state === "ended") { for (const t of c.local.getTracks()) t.stop(); return; }
  c.makePc();
  renderCall();
  try {
    const offer = await c.pc.createOffer();
    await c.pc.setLocalDescription(offer);
    c.signal({ type: "call-offer", video, payload: await sealSdp(contact, c.pc.localDescription.sdp) });
  } catch {
    c.end("Impossible de lancer l'appel", false);
  }
}

async function acceptCall() {
  const c = call;
  if (!c || c.state !== "ringing") return;
  c.state = "connecting";
  renderCall();
  try {
    await c.media();
  } catch {
    c.end("Accès à la caméra ou au micro refusé", true, "error");
    return;
  }
  if (c.state === "ended") { for (const t of c.local.getTracks()) t.stop(); return; }
  c.makePc();
  try {
    await c.pc.setRemoteDescription({ type: "offer", sdp: c.offerSdp });
    c.remoteReady();
    const answer = await c.pc.createAnswer();
    await c.pc.setLocalDescription(answer);
    c.signal({ type: "call-answer", payload: await sealSdp(c.contact, c.pc.localDescription.sdp) });
    renderCall();
  } catch {
    c.end("Impossible de répondre", true, "error");
  }
}

function declineCall() { if (call) call.end(null, true, "declined"); }
function hangUp() { if (call) call.end(null, true); }

/** Appelé par app.js pour tout signal call-* et pour « offline ». */
async function onCallSignal(m) {
  const from = m.from;
  if (m.type === "offline") {
    if (call && call.peerId === from && call.state === "calling") call.end("Hors ligne", false);
    return;
  }
  if (m.type === "call-offer") {
    if (call) {
      if (call.id !== m.callId) sendSignal(from, { type: "call-busy", callId: m.callId });
      return;
    }
    const contact = await contactFor(from);
    if (!contact || typeof m.payload !== "string") return;
    let sdp;
    try { sdp = await openSdp(contact, m.payload); } catch { return; } // pas chiffré pour nous : ignoré
    if (call) { sendSignal(from, { type: "call-busy", callId: m.callId }); return; }
    const c = (call = new Call(contact, !!m.video, false, m.callId));
    c.offerSdp = sdp;
    if (navigator.vibrate) try { navigator.vibrate([400, 200, 400, 200, 400]); } catch {}
    renderCall();
    return;
  }
  const c = call;
  if (!c || c.peerId !== from || c.id !== m.callId) return;
  if (m.type === "call-answer" && c.outgoing && c.pc && !c.remoteSet) {
    try {
      const sdp = await openSdp(c.contact, m.payload);
      await c.pc.setRemoteDescription({ type: "answer", sdp });
      c.remoteReady();
      c.state = "connecting";
      clearTimeout(c.timer);
      renderCall();
    } catch {
      c.end("Réponse invalide", true, "error");
    }
  } else if (m.type === "call-ice") {
    c.addIce(m);
  } else if (m.type === "call-end") {
    if (m.reason === "declined") c.declined = true;
    c.end(m.reason === "declined" ? "Appel refusé" : c.state === "ringing" ? null : "Appel terminé", false);
  } else if (m.type === "call-busy") {
    c.end("Occupé", false);
  }
}

// ---------------------------------------------------------------- Interface d'appel

let callEl = null, tickTimer = null, noteTimer = null;

function attach(el, stream) {
  if (el.srcObject !== stream) el.srcObject = stream;
  const p = el.play();
  if (p && p.catch) p.catch(() => {});
}

function renderCall(note) {
  clearInterval(tickTimer);
  const c = call;
  if (!c) {
    if (!callEl) return;
    if (note) {
      callEl.className = "call ended";
      callEl.replaceChildren(h("div", { class: "call-center" }, h("p", { class: "call-name" }, note)));
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { if (!call && callEl) { callEl.remove(); callEl = null; } }, 1600);
    } else {
      callEl.remove(); callEl = null;
    }
    return;
  }
  clearTimeout(noteTimer);
  if (!callEl) {
    callEl = h("div", { role: "dialog", "aria-modal": "true", "aria-label": "Appel" });
    document.body.append(callEl);
  }
  const showVideo = c.video && (c.state === "active" || c.state === "connecting" || c.outgoing);
  callEl.className = "call" + (showVideo ? " video" : "");

  const status = h("p", { class: "call-status" });
  const setStatus = () => {
    status.textContent = {
      calling: c.pc ? "Ça sonne…" : "Préparation…",
      ringing: c.video ? "Appel vidéo entrant" : "Appel audio entrant",
      connecting: "Connexion…",
      active: fmtDuration(Date.now() - c.startedAt),
    }[c.state] || "";
  };
  setStatus();
  if (c.state === "active") tickTimer = setInterval(setStatus, 1000);

  const kids = [];
  if (showVideo) {
    const rv = h("video", { class: "remote-video", playsinline: true, autoplay: true });
    const lv = h("video", { class: "local-video" + (c.facing === "user" ? " mirror" : "") + (c.camOff ? " off" : ""), playsinline: true, autoplay: true, muted: true });
    lv.muted = true;
    kids.push(rv, lv);
    queueMicrotask(() => { attach(rv, c.remote); if (c.local) attach(lv, c.local); });
  } else {
    const ra = h("audio", { autoplay: true });
    kids.push(ra);
    queueMicrotask(() => attach(ra, c.remote));
  }

  kids.push(h("div", { class: "call-center" },
    h("span", { class: "call-avatar", "aria-hidden": "true" }, c.contact.username[0].toUpperCase()),
    h("p", { class: "call-name" }, c.contact.username),
    status));

  const btn = (label, icon, onclick, cls = "") => h("button", { class: "call-btn " + cls, "aria-label": label, title: label, onclick }, svg(icon));
  const bar = h("div", { class: "call-bar" });
  if (c.state === "ringing") {
    bar.append(
      btn("Refuser", ICON_HANGUP, declineCall, "hang"),
      btn(c.video ? "Accepter l'appel vidéo" : "Accepter l'appel", c.video ? ICON_VIDEO : ICON_PHONE, acceptCall, "accept"),
    );
  } else {
    bar.append(btn(c.muted ? "Réactiver le micro" : "Couper le micro", c.muted ? ICON_MIC_OFF : ICON_MIC, () => c.local && c.toggleMute(), c.muted ? "on" : ""));
    if (c.video) {
      bar.append(
        btn(c.camOff ? "Réactiver la caméra" : "Couper la caméra", c.camOff ? ICON_CAM_OFF : ICON_VIDEO, () => c.local && c.toggleCam(), c.camOff ? "on" : ""),
        btn("Changer de caméra", ICON_FLIP, () => c.flip()),
      );
    }
    bar.append(btn("Raccrocher", ICON_HANGUP, hangUp, "hang"));
  }
  kids.push(bar);
  callEl.replaceChildren(...kids);
}

window.onCallSignal = onCallSignal;
window.startCall = startCall;

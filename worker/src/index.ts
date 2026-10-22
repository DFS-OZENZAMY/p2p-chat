import { DurableObject } from "cloudflare:workers";
import { pushToUser, vapidFromEnv, type Vapid } from "./push";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<Hub>;
  // Relais Cloudflare TURN (facultatif) : `npx wrangler secret put TURN_KEY_ID` / `TURN_KEY_API_TOKEN`
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  // Notifications push (facultatif) : `npm run vapid` crée la clé et l'enregistre en secret
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
}

const vapid = (env: Env): Vapid | null => vapidFromEnv(env.VAPID_PRIVATE_JWK, env.VAPID_SUBJECT);
const MAILBOX_MAX = 500;               // messages en attente par destinataire
const MAILBOX_TTL = 30 * 86400_000;    // 30 jours
const CT_MAX = 12_000;                 // taille max d'un message chiffré (base64)

async function body(req: Request): Promise<any> {
  return (await req.json().catch(() => null)) ?? {};
}

async function nameOf(env: Env, id: string): Promise<{ username: string; publicKey: string } | null> {
  return env.DB.prepare("SELECT username, public_key AS publicKey FROM users WHERE id = ?1").bind(id).first();
}

/** Transmet un signal à un utilisateur via le Hub. Retourne le nombre de connexions atteintes. */
async function hubSend(env: Env, to: string, msg: unknown): Promise<number> {
  const r = await env.HUB.get(env.HUB.idFromName("main")).fetch("https://hub/internal", {
    method: "POST",
    body: JSON.stringify({ to, msg }),
  });
  return Number(await r.text()) || 0;
}

const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

async function authed(env: Env, id: string, token: string): Promise<boolean> {
  if (!id || !token) return false;
  const row = await env.DB.prepare("SELECT token_hash FROM users WHERE id = ?1").bind(id).first<{ token_hash: string }>();
  return !!row && row.token_hash === (await sha256(token));
}

// CORS : permet à la version web (PWA iPhone / navigateur) d'appeler l'annuaire
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", ...CORS } });

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Inscription : enregistre le nom + la clé publique (aucun message ne passe ici)
    if (req.method === "POST" && url.pathname === "/register") {
      const b = (await req.json().catch(() => null)) as any;
      const username = String(b?.username ?? "").toLowerCase();
      const publicKey = String(b?.publicKey ?? "");
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ error: "Nom invalide (3-20 car. : a-z 0-9 _)" }, 400);
      if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) return json({ error: "Clé publique invalide" }, 400);
      const id = crypto.randomUUID();
      const token = crypto.randomUUID() + crypto.randomUUID();
      try {
        await env.DB.prepare(
          "INSERT INTO users (id, username, public_key, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).bind(id, username, publicKey, await sha256(token), Date.now()).run();
      } catch {
        return json({ error: "Nom déjà pris" }, 409);
      }
      return json({ id, token }, 201);
    }

    // Annuaire : recherche par nom d'utilisateur ou par id
    const m = url.pathname.match(/^\/users\/([A-Za-z0-9_-]{3,40})$/);
    if (req.method === "GET" && m) {
      const row = await env.DB.prepare(
        "SELECT id, username, public_key AS publicKey FROM users WHERE username = ?1 OR id = ?1",
      ).bind(m[1].toLowerCase()).first();
      return row ? json(row) : json({ error: "Introuvable" }, 404);
    }

    // Serveurs ICE : STUN + identifiants TURN temporaires (24 h), réservés aux comptes inscrits
    if (req.method === "GET" && url.pathname === "/ice") {
      if (!(await authed(env, url.searchParams.get("id") ?? "", url.searchParams.get("token") ?? "")))
        return json({ error: "unauthorized" }, 401);
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: STUN, turn: false });
      try {
        const r = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ ttl: 86400 }),
          },
        );
        if (!r.ok) return json({ iceServers: STUN, turn: false });
        const d = (await r.json()) as { iceServers?: unknown };
        const list = (Array.isArray(d.iceServers) ? d.iceServers : [d.iceServers]).filter(Boolean) as any[];
        // Les navigateurs refusent le port 53 : on le retire.
        for (const s of list) if (Array.isArray(s.urls)) s.urls = s.urls.filter((u: string) => !/:53\b/.test(u));
        return json({ iceServers: list.length ? list : STUN, turn: list.length > 0 });
      } catch {
        return json({ iceServers: STUN, turn: false });
      }
    }

    // ---------- Notifications push
    if (req.method === "GET" && url.pathname === "/push/key") {
      const v = vapid(env);
      return v ? json({ key: v.publicKey }) : json({ error: "Notifications non configurées" }, 404);
    }

    if (req.method === "POST" && url.pathname === "/push/subscribe") {
      const b = await body(req);
      if (!(await authed(env, String(b.id ?? ""), String(b.token ?? "")))) return json({ error: "unauthorized" }, 401);
      const endpoint = String(b.endpoint ?? ""), p256dh = String(b.p256dh ?? ""), auth = String(b.auth ?? "");
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) return json({ error: "Abonnement invalide" }, 400);
      await env.DB.prepare(
        "INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT(endpoint) DO UPDATE SET user_id = ?2, p256dh = ?3, auth = ?4",
      ).bind(endpoint, b.id, p256dh, auth, Date.now()).run();
      return json({ ok: true });
    }

    // ---------- Boîte aux lettres chiffrée : messages pour un contact hors ligne.
    // Le serveur ne stocke que le texte chiffré de bout en bout ; supprimé dès réception.
    if (req.method === "POST" && url.pathname === "/mailbox/send") {
      const b = await body(req);
      const from = String(b.id ?? ""), to = String(b.to ?? ""), msgId = String(b.msgId ?? ""), ct = String(b.ct ?? "");
      if (!(await authed(env, from, String(b.token ?? "")))) return json({ error: "unauthorized" }, 401);
      if (!to || !/^[A-Za-z0-9-]{8,64}$/.test(msgId) || !ct || ct.length > CT_MAX) return json({ error: "Message invalide" }, 400);
      const sender = await nameOf(env, from);
      if (!sender || !(await nameOf(env, to))) return json({ error: "Destinataire inconnu" }, 404);
      await env.DB.prepare("DELETE FROM mailbox WHERE created_at < ?1").bind(Date.now() - MAILBOX_TTL).run();
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE to_id = ?1").bind(to).first<{ n: number }>();
      if ((n?.n ?? 0) >= MAILBOX_MAX) return json({ error: "Boîte du destinataire pleine" }, 429);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO mailbox (to_id, msg_id, from_id, ct, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(to, msgId, from, ct, Date.now()).run();
      // En ligne : l'app va chercher tout de suite. Sinon : notification push.
      const live = await hubSend(env, to, { type: "mailbox", from });
      let pushed = 0;
      if (!live) {
        pushed = await pushToUser(env.DB, vapid(env), to, {
          t: "msg", from, name: sender.username, key: sender.publicKey, id: msgId, ct: ct.length <= 2800 ? ct : undefined,
        }, { ttl: 4 * 86400, urgency: "high", topic: "m" + from.slice(0, 30) });
      }
      return json({ ok: true, live: live > 0, pushed: pushed > 0 }, 201);
    }

    if (req.method === "GET" && url.pathname === "/mailbox") {
      const id = url.searchParams.get("id") ?? "";
      if (!(await authed(env, id, url.searchParams.get("token") ?? ""))) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        "SELECT msg_id AS msgId, from_id AS fromId, ct, created_at AS at FROM mailbox WHERE to_id = ?1 ORDER BY created_at LIMIT 200",
      ).bind(id).all();
      return json({ messages: results ?? [] });
    }

    if (req.method === "POST" && url.pathname === "/mailbox/ack") {
      const b = await body(req);
      const id = String(b.id ?? "");
      if (!(await authed(env, id, String(b.token ?? "")))) return json({ error: "unauthorized" }, 401);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 200);
      if (ids.length) {
        await env.DB.batch(ids.map((m: string) => env.DB.prepare("DELETE FROM mailbox WHERE to_id = ?1 AND msg_id = ?2").bind(id, m)));
      }
      return json({ ok: true });
    }

    // ---------- Refus d'un appel depuis la notification (sans ouvrir l'app)
    if (req.method === "POST" && url.pathname === "/call/decline") {
      const b = await body(req);
      const id = String(b.id ?? "");
      if (!(await authed(env, id, String(b.token ?? "")))) return json({ error: "unauthorized" }, 401);
      await env.HUB.get(env.HUB.idFromName("main")).fetch("https://hub/decline", {
        method: "POST",
        body: JSON.stringify({ from: id, to: String(b.to ?? ""), callId: String(b.callId ?? "") }),
      });
      return json({ ok: true });
    }

    // Signalisation WebRTC (offer / answer / ice) — relais seulement, rien n'est stocké
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      const id = url.searchParams.get("id") ?? "";
      // Android envoie le jeton dans l'en-tête ; un navigateur ne peut pas, il l'envoie en paramètre.
      const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "") || (url.searchParams.get("token") ?? "");
      if (!(await authed(env, id, token))) return new Response("unauthorized", { status: 401 });
      return env.HUB.get(env.HUB.idFromName("main")).fetch(req);
    }

    return json({ error: "Not found" }, 404);
  },
};

// Relais WebSocket (hibernation : coût nul quand personne n'est connecté).
// Si le destinataire d'un appel n'est pas connecté : notification push + mise en attente
// de l'offre et des candidats ICE pendant 60 s, livrés dès qu'il ouvre l'app.
const PENDING_TTL = 60_000;
type Pending = { at: number; callId: string; msg: any };

export class Hub extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/internal") {
      const { to, msg } = (await req.json()) as { to: string; msg: unknown };
      const peers = this.ctx.getWebSockets(to);
      for (const p of peers) p.send(JSON.stringify(msg));
      return new Response(String(peers.length));
    }
    if (url.pathname === "/decline") {
      const { from, to, callId } = (await req.json()) as { from: string; to: string; callId: string };
      await this.dropPending(from, callId);
      for (const p of this.ctx.getWebSockets(to)) p.send(JSON.stringify({ type: "call-end", reason: "declined", callId, from }));
      return new Response("ok");
    }
    const id = url.searchParams.get("id") ?? "";
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    // Livre les signaux d'appel reçus pendant que l'app était fermée
    const pending = await this.takePending(id);
    for (const p of pending) pair[1].send(JSON.stringify(p.msg));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async takePending(id: string): Promise<Pending[]> {
    const list = ((await this.ctx.storage.get<Pending[]>("p:" + id)) ?? []).filter((p) => Date.now() - p.at < PENDING_TTL);
    await this.ctx.storage.delete("p:" + id);
    return list;
  }

  private async dropPending(id: string, callId: string): Promise<boolean> {
    const list = (await this.ctx.storage.get<Pending[]>("p:" + id)) ?? [];
    const keep = list.filter((p) => p.callId !== callId && Date.now() - p.at < PENDING_TTL);
    if (keep.length) await this.ctx.storage.put("p:" + id, keep); else await this.ctx.storage.delete("p:" + id);
    return keep.length !== list.length;
  }

  private async addPending(id: string, callId: string, msg: any): Promise<void> {
    const list = ((await this.ctx.storage.get<Pending[]>("p:" + id)) ?? []).filter((p) => Date.now() - p.at < PENDING_TTL);
    if (list.length >= 120) return;
    list.push({ at: Date.now(), callId, msg });
    await this.ctx.storage.put("p:" + id, list);
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== "string" || msg.length > 16_384) return;
    const from = this.ctx.getTags(ws)[0];
    let m: any;
    try { m = JSON.parse(msg); } catch { return; }
    // Présence : quels contacts ont l'app ouverte ? (réponse limitée à « connecté ou non »)
    if (m?.type === "presence" && Array.isArray(m.ids)) {
      const online = m.ids.slice(0, 200).filter((x: unknown) => typeof x === "string" && x !== from && this.ctx.getWebSockets(x).length > 0);
      ws.send(JSON.stringify({ type: "presence", online }));
      return;
    }
    if (typeof m?.to !== "string") return;
    const out = { ...m, from };
    const peers = this.ctx.getWebSockets(m.to);
    if (peers.length > 0) {
      const s = JSON.stringify(out);
      for (const p of peers) p.send(s);
      return;
    }
    // Destinataire non connecté
    const type = String(m.type ?? "");
    const callId = String(m.callId ?? "");
    if (type.startsWith("call-") && callId) {
      if (type === "call-offer") {
        const caller = await this.env.DB.prepare("SELECT username FROM users WHERE id = ?1").bind(from).first<{ username: string }>();
        const sent = await pushToUser(this.env.DB, vapid(this.env), m.to, {
          t: "call", from, name: caller?.username ?? "?", video: !!m.video, callId,
        }, { ttl: 45, urgency: "high", topic: "c" + callId.slice(0, 30) });
        if (!sent) { ws.send(JSON.stringify({ type: "offline", from: m.to })); return; }
        await this.addPending(m.to, callId, out);
        ws.send(JSON.stringify({ type: "call-pushed", from: m.to, callId }));
      } else if (type === "call-ice") {
        await this.addPending(m.to, callId, out);
      } else if (type === "call-end") {
        if (await this.dropPending(m.to, callId)) {
          const caller = await this.env.DB.prepare("SELECT username FROM users WHERE id = ?1").bind(from).first<{ username: string }>();
          await pushToUser(this.env.DB, vapid(this.env), m.to, {
            t: "missed", from, name: caller?.username ?? "?", video: !!m.video, callId,
          }, { ttl: 86400, urgency: "normal", topic: "c" + callId.slice(0, 30) });
        }
      }
      return;
    }
    ws.send(JSON.stringify({ type: "offline", from: m.to }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch {}
  }
}

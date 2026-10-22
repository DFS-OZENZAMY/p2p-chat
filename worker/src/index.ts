import { DurableObject } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<Hub>;
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

    // Signalisation WebRTC (offer / answer / ice) — relais seulement, rien n'est stocké
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      const id = url.searchParams.get("id") ?? "";
      // Android envoie le jeton dans l'en-tête ; un navigateur ne peut pas, il l'envoie en paramètre.
      const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "") || (url.searchParams.get("token") ?? "");
      const row = await env.DB.prepare("SELECT token_hash FROM users WHERE id = ?1").bind(id).first<{ token_hash: string }>();
      if (!row || row.token_hash !== (await sha256(token))) return new Response("unauthorized", { status: 401 });
      return env.HUB.get(env.HUB.idFromName("main")).fetch(req);
    }

    return json({ error: "Not found" }, 404);
  },
};

// Relais WebSocket (hibernation : coût nul quand personne n'est connecté)
export class Hub extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== "string" || msg.length > 16_384) return;
    const from = this.ctx.getTags(ws)[0];
    let m: any;
    try { m = JSON.parse(msg); } catch { return; }
    if (typeof m?.to !== "string") return;
    const peers = this.ctx.getWebSockets(m.to);
    if (peers.length === 0) { ws.send(JSON.stringify({ type: "offline", from: m.to })); return; }
    const out = JSON.stringify({ ...m, from });
    for (const p of peers) p.send(out);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}

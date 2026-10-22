// Emoji « super cool » : clavier (recherche FR, récents, couleur de peau), gros emoji animés,
// effets plein écran (pluie d'emoji) et réactions sur les messages. Tout est local : aucune image distante.
"use strict";

const EMO = (() => {
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("fr", { granularity: "grapheme" }) : null;
  const graphemes = (t) => (seg ? [...seg.segment(t)].map((s) => s.segment) : Array.from(t));
  const strip = (e) => e.replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, "");

  // ---------- Détection : message composé uniquement d'emoji (1 à 3) → affichage géant
  const ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\uFE0F|\u20E3|[#*0-9]|\s)+$/u;
  const HAS = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
  function jumboCount(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 40 || !ONLY.test(t) || !HAS.test(t)) return 0;
    const n = graphemes(t).filter((g) => g.trim()).length;
    return n <= 3 ? n : 0;
  }

  // ---------- Animations propres à certains emoji
  const ANIM = {};
  const setAnim = (list, name) => { for (const e of list) ANIM[strip(e)] = name; };
  setAnim(["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💖", "💗", "💓", "💞", "💕", "❤️‍🔥", "😍", "🥰", "😘", "💘", "🫶"], "beat");
  setAnim(["😂", "🤣", "😆", "😹", "😝", "😜"], "laugh");
  setAnim(["👋"], "wave");
  setAnim(["🔥"], "flicker");
  setAnim(["🎉", "🥳", "🎊", "🙌", "👏", "🤩", "🕺", "💃"], "party");
  setAnim(["✨", "⭐", "🌟", "💫", "⚡"], "twinkle");
  setAnim(["🚀"], "launch");
  setAnim(["😢", "😭", "🥺", "😿"], "sob");
  setAnim(["😡", "🤬", "😠", "👿"], "rage");
  setAnim(["👍", "👌", "✌️", "🤙", "💪"], "nod");
  setAnim(["😱", "😮", "😲", "🤯", "😳"], "shock");
  setAnim(["😴", "💤", "🥱"], "sleep");
  setAnim(["🤔", "🧐"], "think");
  setAnim(["🥶", "❄️"], "shiver");
  setAnim(["😎", "🤑", "👑"], "swag");
  const animFor = (e) => ANIM[strip(e)] || "pop";

  // ---------- Effets plein écran
  const FX = {};
  const setFx = (list, chars, dir = "up") => { for (const e of list) FX[strip(e)] = { chars, dir }; };
  setFx(["🎉", "🥳", "🎊"], ["🎉", "🎊", "✨", "🥳"], "down");
  setFx(["❤️", "💖", "💕", "💗", "😍", "🥰", "😘", "💘", "🫶"], ["❤️", "💖", "💕", "💗"]);
  setFx(["🔥", "❤️‍🔥"], ["🔥"]);
  setFx(["😂", "🤣"], ["😂", "🤣"]);
  setFx(["🎂", "🎈", "🎁"], ["🎂", "🎈", "🎁", "🎉"], "down");
  setFx(["🚀"], ["🚀", "✨"]);
  setFx(["✨", "🌟", "⭐", "💫"], ["✨", "⭐", "🌟"], "down");
  setFx(["👏", "🙌"], ["👏", "🙌"]);
  setFx(["💯"], ["💯"]);
  setFx(["❄️", "☃️", "⛄", "🥶"], ["❄️", "❄️", "☃️"], "down");
  setFx(["🌹", "💐", "🌸", "🌷"], ["🌹", "🌸", "🌷", "💐"], "down");
  setFx(["💸", "🤑", "💰"], ["💸", "💵", "💰"], "down");
  setFx(["☀️", "😎"], ["☀️", "😎", "🕶️"]);

  function effectFor(text) {
    for (const g of graphemes(String(text || ""))) { const f = FX[strip(g)]; if (f) return f; }
    return null;
  }

  function burst(fx) {
    if (!fx || reduceMotion() || !Element.prototype.animate || document.documentElement.dataset.fx === "off") return;
    const layer = document.createElement("div");
    layer.className = "fx-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
    const W = innerWidth, H = innerHeight, N = Math.min(34, Math.round(W / 14));
    for (let i = 0; i < N; i++) {
      const s = document.createElement("span");
      s.textContent = fx.chars[i % fx.chars.length];
      const size = 22 + Math.random() * 30;
      s.style.fontSize = size + "px";
      const x = Math.random() * (W - size);
      s.style.left = x + "px";
      layer.append(s);
      const drift = (Math.random() - 0.5) * 160;
      const rot = (Math.random() - 0.5) * 540;
      const from = fx.dir === "down" ? -size - 20 : H + 20;
      const to = fx.dir === "down" ? H + 40 : -size - 60;
      s.style.top = "0px";
      s.animate([
        { transform: `translate(0, ${from}px) rotate(0deg) scale(.6)`, opacity: 0 },
        { opacity: 1, offset: 0.12 },
        { transform: `translate(${drift / 2}px, ${(from + to) / 2}px) rotate(${rot / 2}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${drift}px, ${to}px) rotate(${rot}deg) scale(.9)`, opacity: 0 },
      ], { duration: 2200 + Math.random() * 1400, delay: Math.random() * 700, easing: "cubic-bezier(.25,.6,.35,1)", fill: "both" });
    }
    setTimeout(() => layer.remove(), 4600);
    if (navigator.vibrate) try { navigator.vibrate(18); } catch {}
  }

  // ---------- Données du clavier (chargées à la demande)
  let loading = null;
  function load() {
    if (self.EMOJI_FR) return Promise.resolve();
    if (!loading) loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "emoji-fr.js"; s.onload = res; s.onerror = () => { loading = null; rej(new Error("emoji")); };
      document.head.append(s);
    });
    return loading;
  }

  const GROUPS = [
    ["recent", "🕘", "Récents"], [0, "😀", "Smileys"], [1, "👋", "Personnes"], [3, "🐻", "Animaux et nature"],
    [4, "🍔", "Nourriture"], [5, "✈️", "Voyages"], [6, "⚽", "Activités"], [7, "💡", "Objets"], [8, "💟", "Symboles"], [9, "🏳️", "Drapeaux"],
  ];
  const TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];
  const DEFAULT_RECENT = ["😂", "❤️", "😍", "🥰", "😊", "🙏", "👍", "🔥", "🎉", "😭", "😘", "🥳", "😅", "🤣", "💯", "✨", "😎", "🤔", "👋", "😮", "🫶", "😴", "🚀", "🎂"];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const recents = () => store.get("emojiRecent", DEFAULT_RECENT);
  function pushRecent(e) {
    const base = e;
    const r = recents().filter((x) => strip(x) !== strip(base));
    r.unshift(base);
    store.set("emojiRecent", r.slice(0, 32));
  }
  const tone = () => store.get("emojiTone", 0);
  const withTone = (row) => (row[4] && tone() > 0 ? row[4][tone() - 1] : row[0]);
  const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/’/g, "'").replace(/œ/g, "oe").replace(/æ/g, "ae");

  /** Clavier d'emoji. onPick(emoji). Retourne { el, focusSearch } */
  function picker(onPick, opts = {}) {
    const el = document.createElement("div");
    el.className = "emoji-panel" + (opts.compact ? " compact" : "");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Emoji");
    const search = document.createElement("input");
    search.type = "search"; search.placeholder = "Rechercher un emoji"; search.setAttribute("aria-label", "Rechercher un emoji");
    const toneBtn = document.createElement("button");
    toneBtn.type = "button"; toneBtn.className = "emoji-tone"; toneBtn.title = "Couleur de peau"; toneBtn.setAttribute("aria-label", "Couleur de peau");
    toneBtn.textContent = TONES[tone()];
    const head = document.createElement("div"); head.className = "emoji-head";
    const sw = document.createElement("label"); sw.className = "emoji-search"; sw.append(search);
    head.append(sw, toneBtn);
    const tabs = document.createElement("div"); tabs.className = "emoji-tabs"; tabs.setAttribute("role", "tablist");
    const grid = document.createElement("div"); grid.className = "emoji-grid";
    grid.textContent = "…";
    el.append(head, tabs, grid);

    const btn = (e, label) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "emoji-cell"; b.textContent = e; b.title = label || ""; b.setAttribute("aria-label", label || e);
      return b;
    };
    grid.addEventListener("click", (ev) => {
      const b = ev.target.closest(".emoji-cell");
      if (!b) return;
      const e = b.textContent;
      pushRecent(e);
      b.animate && !reduceMotion() && b.animate([{ transform: "scale(1)" }, { transform: "scale(1.45)" }, { transform: "scale(1)" }], { duration: 260 });
      onPick(e);
    });

    let rows = [];
    const sections = {};
    function renderAll() {
      grid.replaceChildren();
      for (const [g, icon, name] of GROUPS) {
        const sec = document.createElement("section"); sec.className = "emoji-sec";
        const h = document.createElement("h3"); h.textContent = name;
        const cells = document.createElement("div"); cells.className = "emoji-cells";
        if (g === "recent") {
          const known = new Map(rows.map((r) => [strip(r[0]), r]));
          for (const e of recents()) { const r = known.get(strip(e)); cells.append(btn(r ? withTone(r) : e, r ? r[1] : e)); }
        } else {
          for (const r of rows) if (r[3] === g) cells.append(btn(withTone(r), r[1]));
        }
        sec.append(h, cells); grid.append(sec); sections[g] = sec;
      }
    }
    function renderTabs() {
      tabs.replaceChildren(...GROUPS.map(([g, icon, name]) => {
        const t = document.createElement("button");
        t.type = "button"; t.className = "emoji-tab"; t.textContent = icon; t.title = name; t.setAttribute("aria-label", name);
        t.addEventListener("click", () => { search.value = ""; if (!sections[g]) renderAll(); grid.scrollTop = sections[g].offsetTop - grid.offsetTop; mark(g); });
        t.dataset.g = g;
        return t;
      }));
    }
    function mark(g) { for (const t of tabs.children) t.classList.toggle("on", t.dataset.g === String(g)); }
    grid.addEventListener("scroll", () => {
      if (search.value) return;
      let cur = "recent";
      for (const [g] of GROUPS) if (sections[g] && sections[g].offsetTop - grid.offsetTop <= grid.scrollTop + 8) cur = g;
      mark(cur);
    }, { passive: true });
    search.addEventListener("input", () => {
      const q = normalize(search.value.trim());
      if (!q) { renderAll(); mark("recent"); return; }
      const terms = q.split(/\s+/);
      const found = rows.filter((r) => terms.every((t) => r[2].includes(t))).slice(0, 160);
      const cells = document.createElement("div"); cells.className = "emoji-cells";
      for (const r of found) cells.append(btn(withTone(r), r[1]));
      grid.replaceChildren(found.length ? cells : Object.assign(document.createElement("p"), { className: "emoji-none", textContent: "Aucun emoji pour « " + search.value.trim() + " »" }));
      grid.scrollTop = 0;
    });
    toneBtn.addEventListener("click", () => {
      store.set("emojiTone", (tone() + 1) % TONES.length);
      toneBtn.textContent = TONES[tone()];
      if (!search.value) renderAll(); else search.dispatchEvent(new Event("input"));
    });
    renderTabs(); mark("recent");
    load().then(() => { rows = self.EMOJI_FR || []; renderAll(); })
      .catch(() => { grid.textContent = "Impossible de charger les emoji. Vérifie ta connexion."; });
    return { el, focusSearch: () => search.focus() };
  }

  return { jumboCount, animFor, effectFor, burst, picker, graphemes, load, QUICK: ["❤️", "😂", "😮", "😢", "🙏", "👍"] };
})();
self.EMO = EMO;

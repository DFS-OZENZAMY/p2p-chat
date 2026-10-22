# P2P Chat — messagerie chiffrée, de téléphone à téléphone

Les messages et les **appels audio/vidéo** passent **directement d'un appareil à l'autre** (WebRTC), chiffrés de bout en bout.
Le seul serveur est un **annuaire** (Cloudflare Worker + D1) : noms, clés publiques, poignée de main WebRTC, notifications, et une boîte aux lettres pour les messages destinés à un contact hors ligne — toujours chiffrés de bout en bout, illisibles pour le serveur.

**Site et téléchargement : https://dfs-ozenzamy.github.io/p2p-chat/**

**Maquettes UX/UI (Figma) : https://www.figma.com/design/fchrGdrWZ4CSTaMXNvYoON**

| Plateforme | Forme | Installation |
|---|---|---|
| Android 8+ | App native (Kotlin, Compose) | APK de la [dernière version](../../releases/latest) |
| iPhone (iOS 16.4+) | App web installable (PWA) | Safari > Partager > Sur l'écran d'accueil |
| Ordinateur | Même app web | Chrome, Edge, Firefox, Safari |

Les deux versions utilisent exactement le même protocole et le même chiffrement : un utilisateur Android peut écrire à un utilisateur iPhone.

```
app/      Client Android (Kotlin, Compose, Room, WebRTC, Tink)
web/      Client web installable / iPhone (JS sans framework, WebRTC, tweetnacl + WebCrypto)
site/     Page de présentation (GitHub Pages)
worker/   Annuaire + signalisation (Cloudflare Worker, D1, Durable Object)
.github/  Build de l'APK, déploiement du site, déploiement de l'annuaire
```

## Mise en service (une seule fois)

Sans annuaire déployé, l'inscription échoue. Deux façons de le déployer :

**A. Depuis GitHub (recommandé)**
1. Dans Cloudflare : crée un jeton d'API (modèle « Edit Cloudflare Workers » + permission D1 Edit) et note ton Account ID.
2. Ici : Settings > Secrets and variables > Actions > **Secrets** : ajoute `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`.
3. Onglet Actions > « Déployer l'annuaire (Cloudflare) » > Run workflow. L'adresse `https://…workers.dev` s'affiche dans le résumé.

**B. En local**
```bash
cd worker && npm install
npx wrangler d1 create p2p-chat            # copie le database_id dans wrangler.toml
npx wrangler d1 execute p2p-chat --remote --file=schema.sql
npx wrangler deploy                        # note l'URL *.workers.dev
```

Ensuite : Settings > Secrets and variables > Actions > **Variables** > `DIRECTORY_URL` = l'adresse du Worker,
puis relance les workflows « APK Android » et « Site et app web ». L'APK et l'app web pointeront alors sur ton annuaire.
(Dans l'app web, l'adresse peut aussi être saisie à la main dans les réglages.)

## Builds automatiques
- **APK Android** : à chaque modification de `app/`, GitHub Actions compile un APK signé et publie une Release (`p2p-chat.apk`).
  La clé de signature est dans les secrets `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` — ne la change pas, sinon les mises à jour ne s'installeront plus par-dessus.
- **Site + app web** : à chaque modification de `site/` ou `web/`, le site est assemblé et publié sur la branche `gh-pages` (`/` = présentation, `/app/` = l'app).

## Développement local
```bash
cd worker && npx wrangler d1 execute p2p-chat --local --file=schema.sql && npx wrangler dev   # annuaire sur :8787
cd web && python3 -m http.server 8080                                                          # app web
```
Ouvre http://localhost:8080, saisis `http://localhost:8787` comme serveur annuaire.

## Pourquoi pas une app iOS native ?
Distribuer une app native iPhone exige un compte Apple Developer payant, un Mac pour signer et la validation de l'App Store.
La version web installable évite tout cela et s'utilise comme une app (icône, plein écran, hors-ligne pour l'interface).

## Notifications et app fermée (app web)
- **Messages** : si la connexion directe n'est pas établie en 3 s, le message (déjà chiffré de bout en bout) est déposé dans une boîte aux lettres sur l'annuaire (`/mailbox/*`, table `mailbox`), puis supprimé dès que le destinataire le récupère (30 jours max).
- **Notifications** : Web Push standard (RFC 8291 + VAPID, `worker/src/push.ts`, sans dépendance). Le texte est déchiffré sur le téléphone par le service worker (`web/sw.js`).
- **Appels** : si l'appelé n'est pas connecté, l'annuaire envoie une notification « X t'appelle » (Répondre / Refuser) et garde l'offre 60 s pour la livrer à l'ouverture de l'app.
- **Mise en service** : `npm run setup-db` (nouvelles tables) puis `npm run vapid` (clé des notifications), puis `npx wrangler deploy`.
- Sur iPhone : iOS 16.4+ et app ajoutée à l'écran d'accueil.

## Emoji (app web)
- Clavier d'emoji (`web/emoji.js`) : ~1 900 emoji Unicode ≤ 15, recherche en français, récents, couleur de peau. Données `web/emoji-fr.js` générées depuis emojibase-data (MIT), chargées à la demande.
- Message composé de 1 à 3 emoji : affiché en grand et animé (cœur qui bat, main qui salue…).
- Effets plein écran (🎉 ❤️ 🔥 🎂 🚀 …) chez l'expéditeur et le destinataire.
- Réactions (appui long / double-tap ❤️) : envoyées chiffrées comme un message `{id, ts, react, target}` (sans `text`, l'app Android les ignore).

## Appels audio et vidéo (app web)
- Qualité : jusqu'à 1080p / 30 i/s, 3,5 Mbit/s max (adaptatif), Opus 48 kHz 64 kbit/s avec correction d'erreurs.
- Une connexion WebRTC dédiée par appel ; le son et l'image sont chiffrés par WebRTC (DTLS-SRTP).
- L'offre et la réponse SDP, qui portent l'empreinte DTLS, sont chiffrées avec la clé E2E du contact : l'annuaire ne peut pas détourner l'appel.
- Signaux `call-offer`, `call-answer`, `call-ice`, `call-end`, `call-busy` (voir `web/call.js`). L'app Android native les ignore pour l'instant.

## Limites connues
- **App Android native** : pas encore de notifications push ni d'appels (l'app web, elle, les gère).
- **Pas de forward secrecy** : X25519 statique + AES-GCM. Remplacer par libsignal (Double Ratchet).
- **Clés TOFU** : la clé d'un contact est mémorisée à la 1re vue. Ajouter une vérification (numéro de sécurité / QR).
- **TURN** : l'annuaire fournit des identifiants Cloudflare TURN (`GET /ice`) si les secrets `TURN_KEY_ID` et `TURN_KEY_API_TOKEN` sont définis (`npx wrangler secret put …`). L'app Android utilise encore STUN seul (`Config.kt`).
- Base locale non chiffrée (Room / IndexedDB), pas de limitation de débit sur `/register`.

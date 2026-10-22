# P2P Chat — messagerie chiffrée, de téléphone à téléphone

Les messages passent **directement d'un appareil à l'autre** (WebRTC DataChannel), chiffrés de bout en bout.
Le seul serveur est un **annuaire** (Cloudflare Worker + D1) : noms, clés publiques et échange de la poignée de main WebRTC. Aucun message n'y transite ni n'y est stocké.

**Site et téléchargement : https://dfs-ozenzamy.github.io/p2p-chat/**

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
- **Site + app web** : à chaque modification de `site/` ou `web/`, publication sur GitHub Pages (`/` = présentation, `/app/` = l'app).

## Développement local
```bash
cd worker && npx wrangler d1 execute p2p-chat --local --file=schema.sql && npx wrangler dev   # annuaire sur :8787
cd web && python3 -m http.server 8080                                                          # app web
```
Ouvre http://localhost:8080, saisis `http://localhost:8787` comme serveur annuaire.

## Pourquoi pas une app iOS native ?
Distribuer une app native iPhone exige un compte Apple Developer payant, un Mac pour signer et la validation de l'App Store.
La version web installable évite tout cela et s'utilise comme une app (icône, plein écran, hors-ligne pour l'interface).

## Limites connues
- **Les deux apps doivent être ouvertes** : pas de service en arrière-plan ni de notifications push (FCM / Web Push à ajouter).
- **Pas de forward secrecy** : X25519 statique + AES-GCM. Remplacer par libsignal (Double Ratchet).
- **Clés TOFU** : la clé d'un contact est mémorisée à la 1re vue. Ajouter une vérification (numéro de sécurité / QR).
- **TURN** : ajoute un serveur coturn (`Config.kt` et `iceServers` dans `web/config.js`), sinon certains réseaux mobiles ne se connecteront pas.
- Base locale non chiffrée (Room / IndexedDB), pas de limitation de débit sur `/register`.

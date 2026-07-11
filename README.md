# Portfolio conversationnel — Baptiste Fort

Portfolio CV inspiré d’une interface de chat : conversation continue, réponses streamées et notes vocales transcrites côté serveur. Le site public reste sur GitHub Pages et son API est exécutée par un Cloudflare Worker.

## Sécurité de la clé OpenAI

En local, la clé reste uniquement dans `.env`. En production, elle est stockée comme secret chiffré Cloudflare `OPENAI_API_KEY`. Elle n’est jamais incluse dans `index.html`, `app.js`, les requêtes statiques ou le dépôt Git.

La clé précédemment publiée dans une conversation doit être révoquée. Ajoutez uniquement une nouvelle clé dans `.env` :

```dotenv
OPENAI_API_KEY=VOTRE_NOUVELLE_CLE_OPENAI
```

Le chat est volontairement fixé sur `gpt-5.4-mini`. Seul le modèle de transcription est configurable :

```dotenv
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

## Installation et lancement

```bash
cd portfolio-ia
npm install
npm start
```

Puis ouvrir :

```text
http://127.0.0.1:4173/portfolio-ia/
```

Ne plus utiliser `python3 -m http.server` : le chat et la transcription passent par le serveur Node sécurisé.

## Fonctionnalités

- cinq suggestions qui utilisent le même flux que la saisie libre ;
- historique multi-tour sans écrasement des messages précédents ;
- toutes les questions, raccourcis et relances passent par GPT-5.4 mini via la Responses API ;
- personnalité à la première personne, strictement ancrée dans le CV ;
- note vocale avec annulation, validation et transcription ;
- CV PDF, contact, rail latéral et thème clair/sombre ;
- responsive desktop, tablette, mobile et paysage.

Sans clé serveur valide, le chat et la transcription affichent une erreur de configuration explicite. Aucune réponse de portfolio n’est simulée ou écrite en dur.

## Déploiement Cloudflare Worker

Le Worker expose `/api/status`, `/api/chat` et `/api/transcribe`. Il applique une validation d’origine, des limites de taille et quatre compteurs anti-abus avant les appels OpenAI.

```bash
npx wrangler login --use-keyring
npx wrangler secret put OPENAI_API_KEY
npm run worker:deploy
```

Après le déploiement, relier GitHub Pages à la racine du Worker, sans slash final ni chemin `/api` :

```bash
gh variable set PORTFOLIO_API_BASE_URL \
  --repo fortbaptiste/baptiste-fort-cv \
  --body "https://baptiste-fort-cv-api.<sous-domaine>.workers.dev"
gh workflow run pages.yml --repo fortbaptiste/baptiste-fort-cv
```

La clé OpenAI n’est jamais stockée dans les variables GitHub Pages.

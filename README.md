# Portfolio conversationnel — Baptiste Fort

Portfolio CV inspiré d’une interface de chat : conversation continue, réponses streamées et notes vocales transcrites côté serveur.

## Sécurité de la clé OpenAI

La clé reste uniquement dans `.env`, côté serveur. Elle n’est jamais incluse dans `index.html`, `app.js`, les requêtes statiques ou le dépôt Git.

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

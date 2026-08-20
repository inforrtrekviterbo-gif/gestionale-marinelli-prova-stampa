# Configurazione Firebase del gestionale

## Account Authentication

Nel progetto Firebase devono esistere tre utenti Email/Password:

- `admin@gestionale.local`
- `viterbo@gestionale.local`
- `gran-sasso@gestionale.local`

Le password vengono create e gestite soltanto dalla console Firebase Authentication.

## Realtime Database Rules

Aprire **Firebase Console → Realtime Database → Regole**, incollare il contenuto di
`database.rules.json` e pubblicare. Le regole consentono:

- all'amministratore di leggere e sincronizzare entrambi i negozi;
- a Viterbo di leggere e sincronizzare soltanto il nodo `stores/viterbo`;
- a Gran Sasso di leggere e sincronizzare soltanto il nodo `stores/gran-sasso`.

Non usare le regole di test in produzione.

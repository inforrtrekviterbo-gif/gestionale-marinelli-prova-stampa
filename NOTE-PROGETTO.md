# Note progetto — gestionale Marinelli

Gestionale per i negozi di articoli sportivi da montagna (Viterbo e Gran Sasso),
con ponte software verso il registratore di cassa RT.

- Cartella di lavoro: `C:\Users\Utente\Desktop\gestionale-marinelli-repo`
- GitHub: `inforrtrekviterbo-gif/gestionale-marinelli-prova-stampa`
- Un solo ramo: `main`

## Dove gira davvero

Non è GitHub Pages. Il sito sta su **OpenAI Sites** (lo starter `vinext-starter`),
che ricostruisce il commit spinto su `main`. Non ci sono workflow GitHub, né file
Vercel o Netlify. Il `README.md` descrive lo starter generico, non questo
progetto: sull'ospitalità e sul database porta fuori strada.

Dominio in uso: `https://gestionale-marinelli-stefano.stefano-mari-4575.chatgpt.site`

## I database sono due

- **Cloudflare D1** (binding `DB`) tiene i dati veri: vendite, prodotti, clienti,
  scontrini. SQL scritto a mano in `lib/runtime-db.ts`.
- **Firebase Realtime Database** serve solo per l'accesso (tre utenti
  email/password) e per la sincronia fra i due negozi.
- **Cloudflare R2** (binding `BUCKET`) tiene le foto dei prodotti.
- Drizzle (`db/schema.ts`, `db/index.ts`) non lo importa nessuno: è avanzo dello
  starter.

`lib/firebase-config.ts` ha le chiavi di produzione scritte dentro e non esiste
un progetto di prova. **Avviare il gestionale in locale e fare un finto
scontrino scrive nel database vero del negozio.**

## Avviarlo in locale su Windows

`npm run dev` non parte: `package.json` usa `WRANGLER_LOG_PATH=... vite`, sintassi
che cmd.exe non digerisce. Su Windows serve:

```bash
npm ci
export WRANGLER_LOG_PATH=.wrangler/wrangler.log
npx vite
```

Su Linux e macOS `npm run dev` va bene com'è.

## Ponte cassa RT

Una cartella per negozio, ognuna completa e a sé stante:

- `public/rt-bridge/viterbo/` — 13 file storici più il file unico
- `public/rt-bridge/gran-sasso/` — 9 file
- in radice restano i due `.zip` e `INSTALLAZIONE.txt`, che sono quelli che
  `app/gestionale.tsx` offre in scaricamento

I due `MarinelliRTBridge.ps1` **non coincidono** e non vanno fusi: quello di
Viterbo ha la lettura RCH riscritta e il timeout a 20 secondi, quello del Gran
Sasso è fermo alla versione precedente. `ConvertTo-RchDescription` è però
identica nelle due, e deve restare identica a `cleanRchDescription` in
`app/cash-register.tsx`, carattere per carattere: il ponte ricalcola i comandi
attesi e rifiuta lo scontrino se non coincidono.

### File unico di Viterbo

`public/rt-bridge/viterbo/Marinelli-RT-Viterbo.cmd` contiene ponte,
installazione e disinstallazione. Doppio clic e installa; `-Disinstalla` rimuove;
`-SelfTest` fa l'autotest senza chiedere l'amministratore. Il `.ps1` accanto è la
sorgente da cui il `.cmd` è costruito. Un `.ps1` da solo non si esegue: su
Windows il doppio clic lo apre nel Blocco note.

Il corpo del ponte è incorporato alla lettera da `MarinelliRTBridge.ps1`. Va
rigenerato con lo stesso procedimento, mai riscritto a mano.

Tre differenze rispetto all'installazione storica:

1. l'attività pianificata parte all'**accensione** come SISTEMA, non all'accesso
   dell'utente;
2. `-Installa` prova la chiave già installata e la chiede solo se non funziona
   più;
3. il gestionale consegna la chiave rigenerata al ponte da solo, col comando
   locale `setDeviceToken`.

**Ancora mai provato in negozio:** installazione vera, avvio dopo spegnimento
senza che nessuno acceda a Windows, e consegna automatica della chiave.
Quest'ultima funziona solo dal sito pubblicato, mai da `localhost`, per via del
controllo `Origin`.

### Il dominio è incastrato nei ponti

`ApiBaseUrl` è scritto in sette posti. Cinque nel repository: i due
`config-*.example.json`, il `.ps1` e il `.cmd` di Viterbo, e dentro i due `.zip`.
**Due stanno fuori**, su macchine non raggiungibili:
`C:\ProgramData\MarinelliRTBridge\<negozio>\config.json` sui PC di cassa.

Quel valore non dice solo dove chiamare: il ponte lo usa anche per il controllo
`Origin` e rifiuta con 403 le connessioni che arrivano da un dominio diverso.
Cambiare dominio rompe insieme le chiamate del ponte, la stampa dal gestionale, e
pure la consegna automatica della chiave, che viaggia su quel canale e quindi non
si può usare per rimediare.

Rimediare richiede di andare **fisicamente su ogni PC di cassa**. Due negozi, due
interventi. Da mettere in conto prima di traslocare, non a metà.

Idea per togliersi il problema: far accettare al ponte un **elenco** di domini
invece di uno solo, così vecchio e nuovo convivono durante il passaggio.

## Da fare

1. Provare in negozio il file unico di Viterbo (vedi sopra cosa non è provato).
2. Migrare il database su **Supabase** al posto di Firebase. Attenzione: i dati
   veri stanno su D1, non su Firebase — decidere se si sposta tutto o solo
   l'accesso.
3. Mettere il sito su **Vercel**. Va fatto dopo il punto 2: oggi il codice chiede
   i binding `DB` e `BUCKET`, che su Vercel non esistono, e `vinext` è Next su
   Cloudflare Workers. Cambia anche il dominio, con quel che comporta.
4. La cartella `C:\Users\Utente\Desktop\Marinelli-RT-Viterbo (1)` è una copia
   doppia tenuta per sicurezza. Il contenuto è già nel repository.
5. I due `.zip` si rigenerano a mano quando cambiano i file dei ponti.

## Regola di lavoro

Modificare solo questa cartella. `git pull` prima di iniziare, `git push` alla
fine. Così il lavoro da casa e quello dal negozio restano allineati.

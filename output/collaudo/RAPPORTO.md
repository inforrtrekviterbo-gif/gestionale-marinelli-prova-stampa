# Collaudo gestionale Marinelli — 9 settembre 2026

## Esito e limiti

47 scenari API eseguiti: 32 superati, 15 non soddisfano la condizione verificata. Alcuni scenari falliti condividono la stessa causa; non equivalgono a 15 difetti indipendenti. Visibilità dei trasferimenti in ingresso e ripartenza automatica della stampa sono miglioramenti proposti, non requisiti concordati.

Le prove importano le route TypeScript originali senza modificarle, con SQLite temporaneo in memoria e un adattatore dell'interfaccia D1. Le risposte Firebase sono simulate: identità autorizzate, sincronizzazione riuscita e guasto. Nessuna richiesta raggiunge Firebase reale. Nei test simultanei una barriera fa leggere lo stesso stato iniziale alle due richieste prima di proseguire: dimostra l'assenza di protezione nella logica, non misura carico o tempi di Cloudflare reale.

Non è un collaudo completo in produzione. Non verificati: login Firebase reale e regole effettivamente pubblicate, R2 reale e caricamento foto riuscito, interazioni e impaginazione nel browser, stampa fisica RCH/Epson, barcode con lettore reale, backup e ripristino. Safari non è controllabile: il sistema restituisce `Computer Use permissions are not granted`. Nessun browser collegato è disponibile. Il server isolato ha risposto HTTP 200, ma questo non dimostra il funzionamento dell'interfaccia. È stato poi arrestato.

Nessun codice applicativo modificato. Dipendenze installate dal lockfile. Gli azzeramenti provati riguardano soltanto database fittizi in memoria.

## Correzioni prioritarie

### P1 — Salvataggi completi e protezione dalle ripetizioni

- `app/api/data/route.ts:634`: provocando un errore nell'inserimento delle righe resta una vendita senza righe. Vendita, righe, giacenze, buoni e code devono essere salvati come operazione indivisibile.
- `app/cash-register.tsx:549` e `:628`: nessun blocco durante il salvataggio. Ripetere la stessa richiesta crea due vendite. Servono blocco del pulsante e identificatore persistente della richiesta, riconosciuto dal server. Il doppio clic non è stato eseguito nel browser; la duplicazione è riprodotta a livello API.
- `app/api/data/route.ts:600` e `:645`: con 6 pezzi disponibili, due righe da 4 oppure due richieste simultanee da 4 vengono accettate: giacenza finale -2. Aggregare quantità per prodotto e verificare disponibilità nello stesso aggiornamento protetto. Identico difetto nei trasferimenti (`:926`).
- `app/api/data/route.ts:626` e `:705`: due utilizzi simultanei da 10 euro su buono da 10 euro vengono accettati: saldo -10. Addebito condizionato al saldo e controllo dell'esito, dentro il salvataggio unico.

### P1 — Valori e permessi verificati dal server

- `app/api/data/route.ts:529`: quantità -1 con tipo `product` accettata; magazzino passa da 6 a 7 e viene registrato un importo negativo senza percorso reso. Convalidare tipo riga, segno, quantità intere dove necessarie e prezzo.
- `app/api/data/route.ts:613` e `:683`: prenotazione con saldo 7 euro può essere chiusa inviando una riga saldo da zero. Ricavare saldo e condizioni dal database; non fidarsi degli importi inviati dal browser.
- `app/api/data/route.ts:540`: una cassa può associare alla propria vendita un cliente dell'altro negozio tramite ID, anche se la ricerca lo nasconde. Applicare la stessa regola di accesso alla scrittura. Se i clienti devono essere condivisi, rendere coerenti ricerca, dettaglio e vendita.

### P1 — Report completi e PDF senza tagli

- `app/api/data/route.ts:195`, `app/gestionale.tsx:300`: il riepilogo giornaliero/mensile somma soltanto le ultime 300 vendite ricevute. Con 301 vendite, ne riceve 300. Il limite è globale e viene applicato prima del filtro negozio. Calcolare aggregati nel database per periodo e negozio; paginare separatamente lo storico.
- Anche altre liste hanno limiti: buoni/prenotazioni 500, righe analisi 5000, clienti 1000. Da considerare quando si presentano totali o storico completo.
- `lib/pdf.ts:52`: PDF con 50 righe più totale viene troncato dopo 42 righe; totale assente. Generare pagine aggiuntive. Verifica eseguita sul contenuto PDF; resa visiva non verificata, Poppler non disponibile.
- `app/api/pdf/route.ts:35`: lo scontrino di cortesia contiene prezzi, totale e pagamenti, pur dichiarando assenza dei prezzi. Se destinato ai regali, togliere tutti gli importi.

### P2 — Errori gestiti e operatività dei negozi

- `app/api/data/route.ts:964`: creazione tramite azione `createProduct` con EAN già presente lascia prodotto parziale. Il percorso multipart `/api/products` è distinto e ha controlli preventivi. Uniformare validazioni e rollback.
- `app/api/data/route.ts:1043`: i rami restituiscono promesse senza `await` dentro `try`; il `catch` non intercetta i rifiuti asincroni. Riprodotto con EAN duplicato. Restituire errori leggibili, senza lasciare modifiche parziali.
- `app/api/data/route.ts:202`: negozio destinatario non vede il trasferimento entrante. Aggiungere visibilità in ingresso e valutare conferma ricezione: attualmente stock destinatario aumenta subito.
- `app/api/data/route.ts:153`: dopo recupero Firebase, sincronizzazione diventa `synced` ma stampa resta `error`. Esiste riprova manuale. Rendere visibili e recuperabili le code; non ristampare automaticamente quando l'esito fisico è incerto.

## Miglioramenti successivi, da validare con uso reale

1. Backup automatico con prova periodica di ripristino. Non basta la sincronizzazione delle vendite su Firebase: non comprende tutto il gestionale.
2. Registro delle modifiche con operatore, data, prima/dopo e motivo per correzioni di stock, buoni e prenotazioni.
3. Salvataggio del carrello in bozza: oggi vive nello stato React e può perdersi cambiando schermata o ricaricando. Osservazione dal codice, non prova browser.
4. Ordinamento dei riepiloghi con chiavi data, non con le etichette italiane (`app/gestionale.tsx:302`). Osservazione dal codice.
5. Componenti e operazioni più separati per rendere verificabili cassa, magazzino e documenti; dopo i difetti sui dati.

## Controlli tecnici

- Installazione tramite script del progetto: fallisce, `sites-env.sh: Permission denied`. Script richiamato direttamente ma privo del permesso eseguibile nella copia.
- Installazione alternativa `npm ci`: riuscita, 581 pacchetti, lockfile preservato.
- `npm run build`: fallisce per lo stesso permesso sullo script. README documenta inoltre requisiti Linux/GNU timeout.
- `node_modules/.bin/tsc --noEmit --incremental false`: fallisce soltanto con `vite.config.ts(3,27): error TS2307: Cannot find module './.openai/hosting.json' or its corresponding type declarations.` Il file è assente da questa copia.
- `node_modules/.bin/eslint app lib db worker tests`: superato senza segnalazioni.
- Test HTML originale non completato: richiede il build, bloccato come sopra.
- Pacchetti ZIP Viterbo e Gran Sasso: integrità verificata; script ponte incluso uguale al sorgente. Non eseguiti su Windows.

## Riproduzione

Con Node 26 e dipendenze installate, dalla cartella progetto:

```sh
mkdir -p /private/tmp/marinelli-qa
node output/collaudo/checks.mjs
node output/collaudo/extra.mjs
```

Il percorso del progetto è dichiarato in `harness.mjs`. Il primo comando di test scrive i risultati base in `/private/tmp/marinelli-qa/results.json`; il secondo aggiunge gli scenari estesi. L'harness intercetta le richieste esterne e usa database in memoria. `PASS` significa che la condizione di quel singolo scenario è soddisfatta; non certifica il sistema esterno simulato. Le asserzioni fallite sono raccolte nel rapporto: lo script termina normalmente per eseguire tutti gli scenari.

## Matrice completa

| # | Scenario | Esito | Evidenza in caso di fallimento |
|---|---|---|---|
| 1 | Accesso anonimo bloccato | PASS |  |
| 2 | Token Firebase errato respinto | PASS |  |
| 3 | Vendita contanti e scarico magazzino | PASS |  |
| 4 | Vendita carta e pagamento misto | PASS |  |
| 5 | Pagamento incoerente respinto | PASS |  |
| 6 | Giacenza insufficiente respinta | PASS |  |
| 7 | Negozio non può vendere per altro negozio | PASS |  |
| 8 | Operazioni amministrative protette | PASS |  |
| 9 | Bonifico riservato amministratore | PASS |  |
| 10 | Clienti separati e dettaglio protetto | PASS |  |
| 11 | Creazione prodotto e richiamo EAN | PASS |  |
| 12 | Carico rapido EAN | PASS |  |
| 13 | Trasferimento scarica origine e carica destinazione | PASS |  |
| 14 | Buono emissione e consumo | PASS |  |
| 15 | Prenotazione e saldo corretti | PASS |  |
| 16 | Reso originale e doppio reso respinto | PASS |  |
| 17 | Preventivo calcoli e PDF | PASS |  |
| 18 | Accesso PDF altro negozio negato | PASS |  |
| 19 | Guasto Firebase conserva vendita e coda | PASS |  |
| 20 | Ticket stampa usabile una volta | PASS |  |
| 21 | Righe duplicate non superano disponibilità | FAIL | Ricevuto 200, giacenza finale -2 200 !== 409 |
| 22 | Due vendite simultanee non superano disponibilità | FAIL | Risposte 200,200, giacenza finale -2 |
| 23 | Ripetizione richiesta non duplica vendita | FAIL | Stessa richiesta registra 2 vendite 2 !== 1 |
| 24 | Guasto DB non lascia vendita parziale | FAIL | Vendita presente senza righe; Injected database failure 1 !== 0 |
| 25 | Quantità prodotto negativa respinta | FAIL | Accettata vendita negativa; giacenza 7 |
| 26 | Saldo prenotazione non alterabile | FAIL | Prenotazione chiusa pagando zero invece di 7; giacenza 5 |
| 27 | Storico conserva tutte le vendite per i report | FAIL | DB 301 vendite; dashboard riceve 300 300 !== 301 |
| 28 | PDF lungo include ultime righe e totale | FAIL | Totale assente: taglio dopo 42 righe |
| 29 | Scontrino cortesia nasconde importi | FAIL | PDF cortesia contiene totale e importi |
| 30 | Destinatario vede trasferimento in arrivo | FAIL | Trasferimento entrante assente 0 !== 1 |
| 31 | Errore EAN duplicato gestito senza record parziali | FAIL | Prodotto parziale presente; {"status":"exception","error":"UNIQUE constraint failed: product_eans.ean"} 1 !== 0 |
| 32 | Modifica e disattivazione cliente | PASS |  |
| 33 | Modifica prodotto e disattivazione preservano storico | PASS |  |
| 34 | Modifica e annullamento trasferimento ripristinano stock | PASS |  |
| 35 | Annullamento prenotazione libera riserva | PASS |  |
| 36 | Modifica e cancellazione buono | PASS |  |
| 37 | Risuolatura con acconto e saldo | PASS |  |
| 38 | Fattura automatica con bonifico | PASS |  |
| 39 | Prodotto multiplo con varianti | PASS |  |
| 40 | Caricamento foto non valido respinto | PASS |  |
| 41 | Logout invalida sessione | PASS |  |
| 42 | Azzeramento con conferma errata respinto | PASS |  |
| 43 | Azzeramento isolato conserva utenti e registratori | PASS |  |
| 44 | Cliente altro negozio non associabile per ID | FAIL | Vendita accetta cliente di altro negozio non visibile nella ricerca |
| 45 | Buono non spendibile due volte in parallelo | FAIL | Risposte 200,200; saldo buono -10 |
| 46 | Trasferimento con righe duplicate non supera stock | FAIL | Trasferimento accettato; giacenza -2 200 !== 409 |
| 47 | Recupero Firebase riattiva stampa in errore | FAIL | Sincronizzazione recuperata ma stampa resta in errore; serve intervento manuale 'error' !== 'queued' |

# Note progetto — gestionale Marinelli

Gestionale per i negozi di articoli sportivi da montagna (Viterbo e Gran Sasso),
con ponte software verso il registratore di cassa RT.

- Cartella di lavoro: `C:\Users\Utente\Desktop\gestionale-marinelli-repo`
- GitHub: `inforrtrekviterbo-gif/gestionale-marinelli-prova-stampa`
- Un solo ramo: `main`

## Stato al 12 settembre 2026

Unificate le versioni che erano sparse sul PC: l'aspetto grafico nuovo (sfondo
nero, celeste `#087eae`, icone Material Symbols, PWA) e il ponte cassa di
Viterbo collaudato in negozio. Il merge non ha prodotto conflitti: la grafica
tocca `app/`, il ponte tocca `public/rt-bridge/`.

| Commit | Contenuto |
| --- | --- |
| `96a2fa2` | Aspetto grafico nuovo, PWA, livelli di riordino |
| `4d85672` | Ponte RT Viterbo funzionante, timeout RCH, script aggiorna-chiave |
| `183cd03` | Merge dei due |
| `03786ab` | Script locali recuperati (`Applica-Fix-Viterbo`, ponte Node storico) |

Rami `fix-ponte-websocket-null` e `fix-stampa-rch-viterbo` cancellati: erano già
dentro `main`.

## Ponte cassa RT

Tutto in `public/rt-bridge/`. Il ponte gira su Windows come attività pianificata.

- `MarinelliRTBridge.ps1` è la versione collaudata sulla cassa di Viterbo.
- `RchResponseTimeoutSeconds` vale `20` (prima era `180`).
- Il gestionale parla col ponte su `ws://localhost:8080/`, sottoprotocollo
  `marinelli-rt`; il ponte parla con la cassa RCH via telnet.
- `cleanRchDescription` in `app/cash-register.tsx` deve restare **identica** a
  `ConvertTo-RchDescription` nel ponte: il ponte ricalcola i comandi attesi e
  rifiuta lo scontrino se non coincidono carattere per carattere.
- I pacchetti `Marinelli-RT-Viterbo.zip` e `Marinelli-RT-Gran-Sasso.zip` vanno
  rigenerati a mano quando cambiano i file di `public/rt-bridge/`.
- `legacy/ponte-cassa-node/` è il primo ponte in Node.js sulla porta 8085,
  sostituito da quello PowerShell. Solo storico, non usarlo.

## Da fare

1. Eliminare `C:\Users\Utente\Desktop\Marinelli-RT-Viterbo (1)`: copia doppia,
   tenuta per sicurezza. Il contenuto è già tutto qui dentro.
2. Recuperare dal PC di casa il ponte corretto per il negozio del Gran Sasso e
   unirlo a questo repository.
3. Provare la build prima di portare il gestionale in negozio: manca
   `node_modules` e `npm run build` usa script bash più Cloudflare.

## Regola di lavoro

Modificare solo questa cartella. `git pull` prima di iniziare, `git push` alla
fine. Così il lavoro da casa e quello dal negozio restano allineati.

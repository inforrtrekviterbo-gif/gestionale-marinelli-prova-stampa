const WebSocket = require('ws');
const net = require('net');

const PRINTER_IP = '192.168.1.210'; 
const PRINTER_PORT = 23;
const WEBSOCKET_PORT = 8085; // Porta modificata a 8085 per evitare i blocchi di Windows su 8080

const wss = new WebSocket.Server({ port: WEBSOCKET_PORT });
console.log("==================================================");
console.log("   SERVER PONTE VITERBO V19 - PORTA 8085 ATTIVO");
console.log("   In ascolto dal sito web sulla porta: " + WEBSOCKET_PORT);
console.log("   Destinazione Cassa RCH: " + PRINTER_IP + ":" + PRINTER_PORT);
console.log("==================================================");

wss.on('connection', (ws) => {
    console.log('[Sito Web] Gestionale connesso sulla porta 8085.');

    ws.on('message', async (message) => {
        const rawText = message.toString().trim();
        
        // Regola di sicurezza: scarta i messaggi JSON di ping per non mandare in blocco la cassa
        if (rawText.startsWith('{')) {
            ws.send(JSON.stringify({ status: 'ACK' }));
            return;
        }

        console.log('[Sito Web] Ricevuto scontrino dal sito. Filtro tracciato in corso...');
        
        const lines = rawText.split('\n').map(c => c.trim()).filter(c => c.length > 0);
        const cleanCommands = [];

        // 1. APERTURA SCONTRINO FISCALE (Forzata all'inizio per evitare l'errore del cassetto a vuoto)
        cleanCommands.push("=C1");

        let totaleCentesimi = 0;

        for (let line of lines) {
            // Pulisce a fondo il testo rimuovendo accenti, simboli e caratteri non ASCII
            line = line.replace(/·/g, '-').normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, '');

            if (line.startsWith('=R') && line.includes('$')) {
                // Estrazione sicura del prezzo senza rischiare crash del programma
                const matchPrezzo = line.match(/\$(\d+(\.\d+)?)/);
                let prezzoCent = 0;

                if (matchPrezzo) {
                    const valore = parseFloat(matchPrezzo);
                    prezzoCent = valore < 100 ? Math.round(valore * 100) : Math.round(valore);
                }

                totaleCentesimi += prezzoCent;

                // Estrazione e pulizia totale della descrizione (Rimuove parentesi e tiene max 20 lettere)
                let desc = 'ARTICOLO';
                const ultimaBarra = line.lastIndexOf('/');
                if (ultimaBarra !== -1 && ultimaBarra < line.length - 1) {
                    desc = line.substring(ultimaBarra + 1).replace(/[\(\)]/g, '').trim();
                }
                desc = desc.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 20).trim();
                if (desc.length === 0) desc = 'ARTICOLO';

                // Configura la riga sul Reparto 22 reale con l'aliquota IVA in lettere 'a' (IVA 22% in XON-XOFF)
                line = "=R22/$" + prezzoCent + "/a/" + desc;
            }

            // Ignora le vecchie aperture/chiusure errate del sito, le rigeneriamo noi sotto in modo conforme
            if (line.startsWith('=') && line.length >= 2 && !line.startsWith('=K') && !line.startsWith('=C') && !line.startsWith('=T') && !line.startsWith('=S')) {
                cleanCommands.push(line);
            }
        }

        // 2. SUBTOTALE OBBLIGATORIO RCH
        cleanCommands.push("=S");

        // 3. CHIUSURA SCONTRINO (Invia il comando contanti universale senza mandare in tilt la memoria della cassa)
        cleanCommands.push("=T1"); 

        if (cleanCommands.length <= 3) return;

        // APERTURA CONNESSIONE TCP VERSO LA CASSA FISICA DI VITERBO
        const client = new net.Socket();
        client.setTimeout(4000);

        client.connect(PRINTER_PORT, PRINTER_IP, async () => {
            console.log("[Cassa RCH] Connessione riuscita. Invio comandi sanificati...");
            
            for (let i = 0; i < cleanCommands.length; i++) {
                const command = cleanCommands[i];
                console.log("[Cassa RCH] Invio riga " + (i+1) + "/" + cleanCommands.length + ": " + command);
                client.write(command + '\r\n');
                await new Promise(resolve => setTimeout(resolve, 500)); // Mezzo secondo di attesa per la stampa
            }
            
            console.log("[Cassa RCH] Scontrino inviato con successo. Chiusura sessione.\n");
            client.destroy();
            ws.send(JSON.stringify({ status: 'ACK' }));
        });

        client.on('error', (err) => { 
            console.error("[Errore TCP] Impossibile comunicare con la cassa:", err.message); 
            client.destroy(); 
        });
        
        client.on('timeout', () => { 
            console.error("[Errore TCP] Timeout di risposta della cassa."); 
            client.destroy(); 
        });
    });
});
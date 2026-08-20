$ErrorActionPreference = "Stop"
$hostName = "192.168.1.210"
$port = 23
$client = New-Object System.Net.Sockets.TcpClient

try {
  Write-Host "MARINELLI STEFANO - TEST RCH PRINT! 3.0 RT" -ForegroundColor Cyan
  Write-Host "Destinazione: ${hostName}:$port / Protocollo Standard"
  Write-Host "Il test non invia comandi e non stampa documenti.`n"
  $pending = $client.BeginConnect($hostName, $port, $null, $null)
  if (-not $pending.AsyncWaitHandle.WaitOne(5000, $false)) { throw "Timeout dopo 5 secondi." }
  $client.EndConnect($pending)
  if (-not $client.Connected) { throw "Connessione non completata." }
  Write-Host "CONNESSIONE RCH RIUSCITA" -ForegroundColor Green
  Write-Host "La cassa risponde sulla porta configurata."
} catch {
  Write-Host "CONNESSIONE RCH NON RIUSCITA" -ForegroundColor Red
  Write-Host $_.Exception.Message
  Write-Host "Controlla Wi-Fi, IP statico, porta 23 e impostazione Ethernet sulla cassa."
} finally {
  $client.Close()
  Read-Host "`nPremi INVIO per chiudere"
}

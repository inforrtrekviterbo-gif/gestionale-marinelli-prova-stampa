# Test di regressione del dialogo RCH "Protocollo Standard" usato dal ponte RT.
# Windows PowerShell 5.1:  powershell -ExecutionPolicy Bypass -File tests\protocollo-rch.ps1
$ErrorActionPreference = "Stop"

$bridge = Join-Path (Split-Path -Parent $PSScriptRoot) "public\rt-bridge\MarinelliRTBridge.ps1"
$text = Get-Content -LiteralPath $bridge -Raw
$start = $text.IndexOf("function Write-BridgeLog")
$end = $text.IndexOf("`nif (`$SelfTest) {")
if ($start -lt 0 -or $end -lt 0) { throw "Struttura di MarinelliRTBridge.ps1 non riconosciuta." }
Invoke-Expression $text.Substring($start, $end - $start)
$script:Config = [pscustomobject]@{
  RchAddress = "01"
  RchPaymentIndexes = [pscustomobject]@{ cash = 1; card = 4; bank = 8; gift = 10 }
}

$fallite = 0
function Test-Case([string]$Name, [scriptblock]$Body) {
  try { & $Body; Write-Host "OK   $Name" -ForegroundColor Green }
  catch { Write-Host "FAIL $Name -> $($_.Exception.Message)" -ForegroundColor Red; $script:fallite++ }
}

# --- Lettura degli esiti -----------------------------------------------------
# Il registratore di Viterbo risponde con l'identificativo '8' anche a un comando
# inviato con l'identificativo '0': quel byte non e' l'eco di quanto trasmesso.
# Trattarlo come tale bloccava il ponte fino al timeout lasciando lo scontrino
# aperto a meta'. Il frame qui sotto e' quello registrato in bridge.log.
Test-Case "esito con identificativo diverso da quello inviato" {
  [byte[]]$raw = "02-30-31-30-31-30-4E-4F-4E-30-30-30-30-30-30-30-30-38-34-35-03".Split('-') | ForEach-Object { [Convert]::ToByte($_, 16) }
  $stream = New-Object IO.MemoryStream(,$raw)
  $reply = Read-RchReply -Stream $stream -ExpectedPacketId ([char]'0')
  Assert-RchSuccess -Reply $reply
  if ($reply.PacketId -ne '8') { throw "identificativo letto errato: $($reply.PacketId)" }
}

Test-Case "ACK prima dell'esito" {
  [byte[]]$conAck = @([byte]0x06) + (New-RchPacket -Data "ON00000000" -PacketId ([char]'8'))
  $stream = New-Object IO.MemoryStream(,$conAck)
  $reply = Read-RchReply -Stream $stream -ExpectedPacketId ([char]'0')
  if (-not $reply.Acknowledged) { throw "ACK non rilevato" }
  Assert-RchSuccess -Reply $reply
}

Test-Case "NACK segnalato come errore" {
  $stream = New-Object IO.MemoryStream(,([byte[]]@(0x15)))
  try { Read-RchReply -Stream $stream -ExpectedPacketId ([char]'0') | Out-Null; throw "atteso errore" }
  catch { if ($_.Exception.Message -notmatch 'NACK') { throw $_ } }
}

Test-Case "errore bloccante del registratore propagato" {
  $stream = New-Object IO.MemoryStream(,(New-RchPacket -Data "OS00360000" -PacketId ([char]'8')))
  $reply = Read-RchReply -Stream $stream -ExpectedPacketId ([char]'0')
  try { Assert-RchSuccess -Reply $reply; throw "atteso errore" }
  catch { if ($_.Exception.Message -notmatch 'bloccante') { throw $_ } }
}

# --- Comandi di pagamento ----------------------------------------------------
function Get-Pagamenti([object[]]$Payments, [long]$Totale, [double]$Contanti = 0) {
  $lista = New-Object System.Collections.Generic.List[string]
  Add-RchPayments -Commands $lista -Payments $Payments -AdditionalCash $Contanti -TargetCents $Totale
  return ,$lista.ToArray()
}

# Solo "=T1" puo' viaggiare senza importo. Per carta, bancomat e buoni la RCH
# mostra IMPORTO OBBLIGATORIO e blocca il documento con errore E24.
Test-Case "contante pieno chiude senza importo" {
  $c = Get-Pagamenti -Payments @(@{ method = "cash"; amount = 10.0 }) -Totale 1000
  if ($c.Count -ne 1 -or $c[0] -ne '=T1') { throw "ottenuto: $($c -join ' ')" }
}

Test-Case "carta piena porta sempre l'importo" {
  $c = Get-Pagamenti -Payments @(@{ method = "card"; amount = 10.0 }) -Totale 1000
  if ($c.Count -ne 1 -or $c[0] -ne '=T4/$1000') { throw "ottenuto: $($c -join ' ')" }
}

Test-Case "contante piu carta: importo su entrambi" {
  $c = Get-Pagamenti -Payments @(@{ method = "cash"; amount = 4.0 }, @{ method = "card"; amount = 6.0 }) -Totale 1000
  if ($c.Count -ne 2 -or $c[0] -ne '=T1/$400' -or $c[1] -ne '=T4/$600') { throw "ottenuto: $($c -join ' ')" }
}

Test-Case "bancomat e buono regalo portano l'importo" {
  $c = Get-Pagamenti -Payments @(@{ method = "gift"; amount = 2.5 }, @{ method = "bank"; amount = 7.5 }) -Totale 1000
  if ($c.Count -ne 2 -or $c[0] -ne '=T10/$250' -or $c[1] -ne '=T8/$750') { throw "ottenuto: $($c -join ' ')" }
}

Test-Case "somma pagamenti diversa dal totale viene rifiutata" {
  try { Get-Pagamenti -Payments @(@{ method = "card"; amount = 9.0 }) -Totale 1000 | Out-Null; throw "atteso errore" }
  catch { if ($_.Exception.Message -notmatch 'non coincide') { throw $_ } }
}

if ($fallite) { exit 1 }
Write-Host "`nTutti i test del protocollo RCH superati." -ForegroundColor Cyan

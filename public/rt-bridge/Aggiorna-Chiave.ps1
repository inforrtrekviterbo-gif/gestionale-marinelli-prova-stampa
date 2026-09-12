param(
  [string]$Chiave,
  [string]$ConfigPath = "C:\ProgramData\MarinelliRTBridge\Viterbo\config.json",
  [string]$Task = "Marinelli RT Bridge - Viterbo"
)

$ErrorActionPreference = "Stop"
$interattivo = -not $PSBoundParameters.ContainsKey('Chiave')
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Test-ChiaveSulGestionale {
  param([string]$BaseUrl, [string]$Store, [string]$Token)
  $uri = "$($BaseUrl.TrimEnd('/'))/api/fiscal?store=$([Uri]::EscapeDataString($Store))&action=status"
  try {
    Invoke-RestMethod -Method Get -Uri $uri -Headers @{ Authorization = "Bearer $Token" } -UseBasicParsing -TimeoutSec 30 | Out-Null
    return $null
  } catch [Net.WebException] {
    $stato = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($stato -eq 401) { return "Il gestionale rifiuta questa chiave (401). Controlla di aver copiato la chiave per il negozio giusto e che in Amministrazione > Registratori RT lo Stato del negozio sia Abilitato." }
    if ($stato -eq 400) { return "Il gestionale non riconosce il negozio '$Store'." }
    if ($stato -gt 0) { return "Il gestionale ha risposto $stato." }
    return "Gestionale non raggiungibile: $($_.Exception.Message)"
  } catch {
    return "Gestionale non raggiungibile: $($_.Exception.Message)"
  }
}

try {
  Write-Host "MARINELLI STEFANO - AGGIORNA CHIAVE PONTE" -ForegroundColor Cyan
  Write-Host ""

  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "config.json non trovato: $ConfigPath" }
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  Write-Host "Negozio    : $($config.Store)"
  Write-Host "Gestionale : $($config.ApiBaseUrl)"
  Write-Host ""

  # Prima di chiedere una chiave nuova: forse quella attuale funziona ancora e
  # non serve rigenerare niente. Rigenerare la chiave e' proprio cio' che scollega
  # il ponte, quindi conviene guardare prima.
  Write-Host "Controllo la chiave attuale..." -ForegroundColor Gray
  $problemaAttuale = Test-ChiaveSulGestionale -BaseUrl $config.ApiBaseUrl -Store $config.Store -Token $config.DeviceToken
  if (-not $problemaAttuale) {
    Write-Host "La chiave gia' installata funziona. Non serve rigenerarla." -ForegroundColor Green
    Write-Host "Se il gestionale dice che la cassa e' scollegata, il problema e' altrove: guarda il registro del ponte." -ForegroundColor Yellow
    return
  }
  Write-Host "Chiave attuale non valida: $problemaAttuale" -ForegroundColor Yellow
  Write-Host ""

  if (-not $Chiave) {
    Write-Host "Nel gestionale, come amministratore: Amministrazione > Registratori RT > Rigenera chiave."
    Write-Host "Poi incollala qui sotto (tasto destro del mouse incolla) e premi INVIO."
    Write-Host ""
    $Chiave = Read-Host "Chiave nuova"
  }
  $Chiave = ([string]$Chiave).Trim()
  if (-not $Chiave) { throw "Nessuna chiave inserita." }
  if ($Chiave -notmatch '^msrt_[A-Za-z0-9_-]{20,}$') { throw "Questa non sembra una chiave del ponte: deve iniziare con msrt_ . Ricopiala per intero." }

  # Si prova la chiave PRIMA di scriverla: se e' sbagliata, config.json resta
  # quello buono e il ponte continua a girare com'era.
  Write-Host ""
  Write-Host "Provo la chiave nuova sul gestionale..." -ForegroundColor Gray
  $problema = Test-ChiaveSulGestionale -BaseUrl $config.ApiBaseUrl -Store $config.Store -Token $Chiave
  if ($problema) { throw $problema }
  Write-Host "1/3 Chiave accettata dal gestionale." -ForegroundColor Green

  Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak" -Force
  $config.DeviceToken = $Chiave
  ($config | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  Write-Host "2/3 Chiave salvata in config.json (copia di sicurezza in config.json.bak)." -ForegroundColor Green

  Stop-ScheduledTask -TaskName $Task
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $Task
  Start-Sleep -Seconds 5
  Write-Host "3/3 Ponte riavviato." -ForegroundColor Green

  if ($config.LogPath -and (Test-Path -LiteralPath $config.LogPath)) {
    Write-Host ""
    Write-Host "Ultime righe del registro:" -ForegroundColor Cyan
    Get-Content -LiteralPath $config.LogPath -Tail 6
  }
  Write-Host ""
  Write-Host "FATTO. Ricarica il gestionale nel browser." -ForegroundColor Cyan
} catch {
  Write-Host ""
  Write-Host "AGGIORNAMENTO NON RIUSCITO" -ForegroundColor Red
  Write-Host $_.Exception.Message
} finally {
  if ($interattivo) { Read-Host "`nPremi INVIO per chiudere" | Out-Null }
}

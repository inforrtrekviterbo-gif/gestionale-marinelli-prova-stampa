param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Viterbo", "Gran Sasso")]
  [string]$Store
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Stop-WithMessage([string]$Message) {
  Write-Host "`nERRORE: $Message" -ForegroundColor Red
  Read-Host "Premi INVIO per chiudere"
  exit 1
}

function Test-TcpEndpoint {
  param([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 5000)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) { throw "Timeout." }
    $client.EndConnect($pending)
    return $client.Connected
  } finally {
    $client.Close()
  }
}

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-WithMessage "Avvia il file di installazione come amministratore."
  }

  $sourceRoot = $PSScriptRoot
  $bridgeSource = Join-Path $sourceRoot "MarinelliRTBridge.ps1"
  $templateName = if ($Store -eq "Viterbo") { "config-viterbo.example.json" } else { "config-gran-sasso.example.json" }
  $configSource = Join-Path $sourceRoot $templateName
  if (-not (Test-Path -LiteralPath $bridgeSource) -or -not (Test-Path -LiteralPath $configSource)) {
    Stop-WithMessage "Il pacchetto non e completo. Estrai tutto lo ZIP prima di avviare l'installazione."
  }

  Write-Host "MARINELLI STEFANO - COLLEGAMENTO REGISTRATORE RT" -ForegroundColor Green
  Write-Host "Negozio: $Store`n"
  $secureToken = Read-Host "Incolla la chiave generata in Amministrazione > Registratori RT" -AsSecureString
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
  if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
    Stop-WithMessage "La chiave inserita non e valida."
  }

  $slug = if ($Store -eq "Viterbo") { "Viterbo" } else { "GranSasso" }
  $installRoot = Join-Path $env:ProgramData "MarinelliRTBridge\$slug"
  $taskName = "Marinelli RT Bridge - $Store"
  $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Copy-Item -LiteralPath $bridgeSource -Destination (Join-Path $installRoot "MarinelliRTBridge.ps1") -Force
  if ($Store -eq "Viterbo") {
    $selfTest = Start-Process -FilePath $powerShell -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $installRoot "MarinelliRTBridge.ps1"), "-SelfTest") -PassThru -Wait -NoNewWindow
    if ($selfTest.ExitCode -ne 0) { Stop-WithMessage "Autotest del Protocollo Standard RCH non riuscito." }
  }
  $config = Get-Content -LiteralPath $configSource -Raw | ConvertFrom-Json
  $config.DeviceToken = $token.Trim()
  $config | Add-Member -NotePropertyName LogPath -NotePropertyValue (Join-Path $installRoot "bridge.log") -Force
  $config | Add-Member -NotePropertyName FiscalJobsNotBeforeUtc -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force

  Write-Host "Verifica e associazione della chiave $Store..." -ForegroundColor Cyan
  try {
    $headers = @{ Authorization = "Bearer $($config.DeviceToken)" }
    $pairingBody = @{ action = "heartbeat"; store = $Store; status = "installing"; error = "" } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$($config.ApiBaseUrl.TrimEnd('/'))/api/fiscal" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $pairingBody -UseBasicParsing -TimeoutSec 30 | Out-Null
  } catch {
    Stop-WithMessage "La chiave $Store e stata rifiutata dal gestionale. Genera una nuova chiave del negozio corretto e ripeti l'installazione. Dettaglio: $($_.Exception.Message)"
  }
  Write-Host "Chiave verificata e ponte $Store abilitato." -ForegroundColor Green

  if ($Store -eq "Viterbo") {
    $rchHost = Read-Host "Indirizzo IP RCH [$($config.RchHost)]"
    if (-not [string]::IsNullOrWhiteSpace($rchHost)) { $config.RchHost = $rchHost.Trim() }
    $rchPort = Read-Host "Porta RCH [$($config.RchPort)]"
    if (-not [string]::IsNullOrWhiteSpace($rchPort)) { $config.RchPort = [int]$rchPort }
    Write-Host "Verifica Wi-Fi/TCP verso $($config.RchHost):$($config.RchPort)..." -ForegroundColor Cyan
    try { $reachable = Test-TcpEndpoint -HostName ([string]$config.RchHost) -Port ([int]$config.RchPort) }
    catch { Stop-WithMessage "La cassa RCH non risponde su $($config.RchHost):$($config.RchPort). $($_.Exception.Message)" }
    if (-not $reachable) { Stop-WithMessage "La cassa RCH non risponde su $($config.RchHost):$($config.RchPort)." }
    Write-Host "RCH raggiungibile. Il test non ha inviato comandi alla cassa." -ForegroundColor Green
  } else {
    $fpMate = Read-Host "Percorso EpsonFpMate.exe [$($config.EpsonFpMatePath)]"
    if (-not [string]::IsNullOrWhiteSpace($fpMate)) { $config.EpsonFpMatePath = $fpMate.Trim() }
    if (-not (Test-Path -LiteralPath $config.EpsonFpMatePath)) {
      Stop-WithMessage "EpsonFpMate.exe non trovato. Fallo installare dal tecnico Epson e ripeti l'installazione."
    }
    $config.WorkDirectory = Join-Path $installRoot "Epson\Input"
    $config.EpsonOutputDirectory = Join-Path $installRoot "Epson\Output"
    New-Item -ItemType Directory -Force -Path $config.WorkDirectory, $config.EpsonOutputDirectory | Out-Null
  }

  $configPath = Join-Path $installRoot "config.json"
  $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
  & icacls.exe $configPath /inheritance:r /grant:r "$($identity.Name):(R,W)" "SYSTEM:(F)" | Out-Null

  $localPort = if ($config.LocalWebSocketPort) { [int]$config.LocalWebSocketPort } else { 8080 }
  $localPrefix = "http://localhost:$localPort/"
  & netsh.exe http show urlacl "url=$localPrefix" *> $null
  if ($LASTEXITCODE -ne 0) {
    & netsh.exe http add urlacl "url=$localPrefix" "user=$($identity.Name)" | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Impossibile riservare il collegamento locale $localPrefix." }
  }

  $bridgePath = Join-Path $installRoot "MarinelliRTBridge.ps1"
  $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$bridgePath`" -ConfigPath `"$configPath`""
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $installRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Description "Collegamento automatico tra il gestionale Marinelli Stefano e il registratore RT $Store." -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 4
  $task = Get-ScheduledTask -TaskName $taskName
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  if ($task.State -ne "Running") {
    Stop-WithMessage "L'avvio automatico non e riuscito. Codice Windows: $($info.LastTaskResult)."
  }

  Write-Host "`nINSTALLAZIONE COMPLETATA" -ForegroundColor Green
  Write-Host "Il collegamento parte automaticamente e resta nascosto."
  Write-Host "Canale locale: ws://localhost:$localPort"
  Write-Host "Stato attuale: in esecuzione"
  Write-Host "Registro tecnico: $(Join-Path $installRoot 'bridge.log')"
  if ($Store -eq "Viterbo") {
    Write-Host "`nIl collegamento e gia abilitato. Torna nel gestionale e attendi lo stato COLLEGATO."
    Write-Host "Il ponte inviera direttamente gli scontrini tramite Protocollo Standard RCH e chiudera automaticamente l'Opzione Fidelity." -ForegroundColor Green
    Write-Host "Prima dell'uso ordinario effettuare uno scontrino di prova in modalita formazione e verificare reparto 1, pagamenti 1/4 e stati aggiuntivi attivi con il tecnico fiscale. Il ponte gestisce ACK attivo o disattivato." -ForegroundColor Yellow
  } else {
    Write-Host "`nIl collegamento e gia abilitato. Torna nel gestionale, attendi lo stato COLLEGATO e fai una stampa di prova con il tecnico fiscale."
  }
  Read-Host "Premi INVIO per chiudere"
} catch {
  Stop-WithMessage $_.Exception.Message
}

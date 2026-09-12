$ErrorActionPreference = "Stop"
$sorgente = Join-Path $PSScriptRoot "MarinelliRTBridge.ps1"
$destinazione = "C:\ProgramData\MarinelliRTBridge\Viterbo\MarinelliRTBridge.ps1"
$task = "Marinelli RT Bridge - Viterbo"

try {
  Write-Host "MARINELLI STEFANO - APPLICA CORREZIONE PONTE VITERBO" -ForegroundColor Cyan

  Copy-Item -LiteralPath $sorgente -Destination $destinazione -Force
  Write-Host "1/3 Ponte aggiornato." -ForegroundColor Green

  Stop-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $task
  Write-Host "2/3 Ponte riavviato." -ForegroundColor Green

  Start-Sleep -Seconds 5
  Write-Host "3/3 Ultime righe del registro:" -ForegroundColor Green
  Get-Content "C:\ProgramData\MarinelliRTBridge\Viterbo\bridge.log" -Tail 5

  Write-Host "`nFATTO. Ora ricarica il gestionale nel browser." -ForegroundColor Cyan
} catch {
  Write-Host "CORREZIONE NON RIUSCITA" -ForegroundColor Red
  Write-Host $_.Exception.Message
} finally {
  Read-Host "`nPremi INVIO per chiudere"
}

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Viterbo", "Gran Sasso")]
  [string]$Store,
  [switch]$EliminaConfigurazione
)

$ErrorActionPreference = "Stop"
$taskName = "Marinelli RT Bridge - $Store"
$slug = if ($Store -eq "Viterbo") { "Viterbo" } else { "GranSasso" }
$installRoot = Join-Path $env:ProgramData "MarinelliRTBridge\$slug"

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
if ($EliminaConfigurazione -and (Test-Path -LiteralPath $installRoot)) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force
}
Write-Host "Avvio automatico $Store rimosso." -ForegroundColor Green

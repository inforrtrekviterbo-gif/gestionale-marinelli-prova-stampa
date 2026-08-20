param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "config.json"),
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-BridgeLog {
  param([string]$Message, [string]$Level = "INFO")
  $line = "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) [$Level] $Message"
  if ($script:Config -and $script:Config.LogPath) {
    $logPath = [string]$script:Config.LogPath
    $logDirectory = Split-Path -Parent $logPath
    if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5242880) {
      Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
    }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  }
  Write-Host $line
}

function Read-BridgeConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "File config.json non trovato: $ConfigPath" }
  $value = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not $value.ApiBaseUrl -or -not $value.Store -or -not $value.DeviceToken -or -not $value.Adapter) {
    throw "ApiBaseUrl, Store, DeviceToken e Adapter sono obbligatori."
  }
  return $value
}

function Invoke-BridgeApi {
  param([string]$Method, [string]$Path, [object]$Body = $null)
  $headers = @{ Authorization = "Bearer $($script:Config.DeviceToken)" }
  $uri = "$($script:Config.ApiBaseUrl.TrimEnd('/'))$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -UseBasicParsing -TimeoutSec 30
  }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType "application/json; charset=utf-8" -Body ($Body | ConvertTo-Json -Depth 20 -Compress) -UseBasicParsing -TimeoutSec 30
}

function Format-ItalianNumber([double]$Value) {
  return $Value.ToString("0.###", [Globalization.CultureInfo]::InvariantCulture).Replace(".", ",")
}

function Escape-Xml([string]$Value, [int]$Maximum = 38) {
  $clean = ($Value -replace "[\r\n|]", " ").Trim()
  if ($clean.Length -gt $Maximum) { $clean = $clean.Substring(0, $Maximum) }
  return [Security.SecurityElement]::Escape($clean)
}

function Test-TcpEndpoint {
  param([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 3000)
  if ([string]::IsNullOrWhiteSpace($HostName)) { throw "Indirizzo IP RCH non configurato." }
  if ($Port -lt 1 -or $Port -gt 65535) { throw "Porta RCH non valida: $Port." }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
      throw "Timeout collegamento RCH a ${HostName}:$Port."
    }
    $client.EndConnect($pending)
    if (-not $client.Connected) { throw "RCH non raggiungibile a ${HostName}:$Port." }
    return $true
  } finally {
    $client.Close()
  }
}

function ConvertTo-RchDescription {
  param([string]$Value, [int]$Maximum = 36)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "ARTICOLO" }
  $normalized = $Value.Normalize([Text.NormalizationForm]::FormD)
  $builder = New-Object Text.StringBuilder
  foreach ($character in $normalized.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($character) -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$builder.Append($character)
    }
  }
  $clean = $builder.ToString().Normalize([Text.NormalizationForm]::FormC)
  $clean = [regex]::Replace($clean, '[^\x20-\x7E]', ' ')
  $clean = [regex]::Replace($clean, '[/()$*\[\]^_@]', ' ')
  $clean = [regex]::Replace($clean, '\s+', ' ').Trim()
  if (-not $clean) { $clean = "ARTICOLO" }
  if ($clean.Length -gt $Maximum) { $clean = $clean.Substring(0, $Maximum).Trim() }
  return $clean
}

function ConvertTo-RchCents([double]$Value) {
  return [int64][Math]::Round($Value * 100, 0, [MidpointRounding]::AwayFromZero)
}

function Format-RchQuantity([double]$Value) {
  if ($Value -le 0 -or $Value -gt 999999) { throw "Quantita RCH non valida: $Value." }
  $rounded = [Math]::Round($Value, 3, [MidpointRounding]::AwayFromZero)
  if ([Math]::Abs($rounded - $Value) -gt 0.0005) { throw "La quantita RCH ammette al massimo tre decimali." }
  return $rounded.ToString("0.###", [Globalization.CultureInfo]::InvariantCulture)
}

function New-RchPacket {
  param([string]$Data, [char]$PacketId)
  if ([string]::IsNullOrEmpty($Data) -or $Data.Length -gt 999) { throw "Lunghezza comando RCH non valida." }
  $address = if ($script:Config -and $script:Config.RchAddress) { [string]$script:Config.RchAddress } else { "01" }
  if ($address -notmatch '^\d{2}$') { throw "RchAddress deve contenere due cifre." }
  $body = "$address$($Data.Length.ToString('000'))N$Data$PacketId"
  [byte[]]$bodyBytes = [Text.Encoding]::ASCII.GetBytes($body)
  [byte[]]$packet = New-Object byte[] ($bodyBytes.Length + 4)
  $packet[0] = 0x02
  [Array]::Copy($bodyBytes, 0, $packet, 1, $bodyBytes.Length)
  [byte]$checksum = 0
  for ($index = 0; $index -le $bodyBytes.Length; $index++) { $checksum = $checksum -bxor $packet[$index] }
  [byte[]]$checksumBytes = [Text.Encoding]::ASCII.GetBytes($checksum.ToString("X2"))
  $packet[$bodyBytes.Length + 1] = $checksumBytes[0]
  $packet[$bodyBytes.Length + 2] = $checksumBytes[1]
  $packet[$bodyBytes.Length + 3] = 0x03
  return ,$packet
}

function Read-ExactBytes {
  param([System.IO.Stream]$Stream, [int]$Count)
  [byte[]]$buffer = New-Object byte[] $Count
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -le 0) { throw "Connessione RCH chiusa durante la risposta." }
    $offset += $read
  }
  return ,$buffer
}

function Read-RchFrame {
  param([System.IO.Stream]$Stream, [int]$FirstByte = -1)
  if ($FirstByte -lt 0) { $FirstByte = $Stream.ReadByte() }
  if ($FirstByte -eq 0x15) { throw "RCH ha risposto NACK: pacchetto non ricevuto correttamente." }
  if ($FirstByte -ne 0x02) { throw "Risposta RCH inattesa: byte iniziale 0x$($FirstByte.ToString('X2'))." }
  [byte[]]$header = Read-ExactBytes -Stream $Stream -Count 6
  $lengthText = [Text.Encoding]::ASCII.GetString($header, 2, 3)
  $dataLength = 0
  if (-not [int]::TryParse($lengthText, [ref]$dataLength) -or $dataLength -lt 1 -or $dataLength -gt 999) {
    throw "Lunghezza risposta RCH non valida: $lengthText."
  }
  [byte[]]$tail = Read-ExactBytes -Stream $Stream -Count ($dataLength + 4)
  [byte[]]$frame = New-Object byte[] (1 + $header.Length + $tail.Length)
  $frame[0] = 0x02
  [Array]::Copy($header, 0, $frame, 1, $header.Length)
  [Array]::Copy($tail, 0, $frame, 1 + $header.Length, $tail.Length)
  if ($frame[$frame.Length - 1] -ne 0x03) { throw "Terminatore ETX assente nella risposta RCH." }
  if ([char]$frame[6] -ne 'N') { throw "Identificatore protocollo RCH non valido." }
  [byte]$calculated = 0
  $packetIdIndex = 7 + $dataLength
  for ($index = 0; $index -le $packetIdIndex; $index++) { $calculated = $calculated -bxor $frame[$index] }
  $receivedChecksum = [Text.Encoding]::ASCII.GetString($frame, $packetIdIndex + 1, 2)
  if ($receivedChecksum -ne $calculated.ToString("X2")) { throw "Checksum risposta RCH non valido." }
  return [pscustomobject]@{
    Data = [Text.Encoding]::ASCII.GetString($frame, 7, $dataLength)
    PacketId = [char]$frame[$packetIdIndex]
  }
}

function ConvertFrom-RchFrame {
  param([object]$Frame, [bool]$Acknowledged = $false)
  if ($Frame.Data.Length -lt 10) { throw "Messaggio di esito RCH incompleto." }
  return [pscustomobject]@{
    Acknowledged = $Acknowledged
    PacketId = $Frame.PacketId
    Type = $Frame.Data.Substring(0, 1)
    ErrorFamily = $Frame.Data.Substring(1, 1)
    ErrorCode = $Frame.Data.Substring(2, 4)
    DocumentState = $Frame.Data.Substring(6, 2)
    Follows = $Frame.Data.Substring(8, 1)
    Reserved = $Frame.Data.Substring(9, 1)
  }
}

function Read-RchReply {
  param([System.IO.Stream]$Stream, [char]$ExpectedPacketId)
  $first = $Stream.ReadByte()
  if ($first -lt 0) { throw "RCH non ha restituito alcuna risposta." }
  $acknowledged = $false
  if ($first -eq 0x06) {
    $acknowledged = $true
    $first = $Stream.ReadByte()
    if ($first -lt 0) { throw "RCH ha confermato la ricezione ma non ha inviato l'esito." }
  }
  $frame = Read-RchFrame -Stream $Stream -FirstByte $first
  if ($frame.PacketId -ne $ExpectedPacketId) { throw "Risposta RCH associata a un pacchetto differente." }
  return (ConvertFrom-RchFrame -Frame $frame -Acknowledged $acknowledged)
}

function Assert-RchSuccess {
  param([object]$Reply)
  if ($Reply.Type -ne "O" -or $Reply.ErrorFamily -ne "N" -or $Reply.ErrorCode -ne "0000") {
    $code = if ($Reply.ErrorCode -eq "0000") { "non specificato" } else { "E$([int]$Reply.ErrorCode)" }
    $family = switch ($Reply.ErrorFamily) { "P" { "fine carta" } "S" { "bloccante" } default { "generico" } }
    throw "Errore RCH $code ($family), stato documento $($Reply.DocumentState). Verificare il display del registratore prima di riprovare."
  }
}

function Invoke-RchCommand {
  param([System.IO.Stream]$Stream, [string]$Command, [char]$PacketId)
  [byte[]]$packet = New-RchPacket -Data $Command -PacketId $PacketId
  $Stream.Write($packet, 0, $packet.Length)
  $Stream.Flush()
  $reply = Read-RchReply -Stream $Stream -ExpectedPacketId $PacketId
  if ($reply.ErrorFamily -eq "P" -and $reply.Follows -eq "1") {
    Write-BridgeLog "RCH segnala fine carta: sostituire il rotolo. In attesa dell'esito conclusivo." "WARN"
    $reply = Read-RchReply -Stream $Stream -ExpectedPacketId $PacketId
  }
  Assert-RchSuccess -Reply $reply
  return $reply
}

function Invoke-RchFidelityClose {
  param(
    [System.IO.Stream]$Stream,
    [string]$PaymentCommand,
    [char]$PaymentPacketId,
    [char]$ClosePacketId
  )
  [byte[]]$paymentPacket = New-RchPacket -Data $PaymentCommand -PacketId $PaymentPacketId
  $Stream.Write($paymentPacket, 0, $paymentPacket.Length)
  $Stream.Flush()
  Write-BridgeLog "Pagamento RCH inviato; invio immediato della chiusura Fidelity compatibile con ACK attivo o disattivato."

  # Con Opzione Fidelity attiva il comando di pagamento apre il cassetto ma il
  # documento viene stampato soltanto dopo il terminatore =c. L'ACK del RT puo
  # essere disattivato: non va quindi atteso prima di accodare la chiusura.
  Start-Sleep -Milliseconds 100
  [byte[]]$closePacket = New-RchPacket -Data "=c" -PacketId $ClosePacketId
  $Stream.Write($closePacket, 0, $closePacket.Length)
  $Stream.Flush()
  Write-BridgeLog "Chiusura Fidelity RCH (=c) inviata."

  $paymentAcknowledged = $false
  $paymentReply = $null
  $closeAcknowledged = $false
  $closeReply = $null
  $ackCount = 0
  for ($messageIndex = 0; $messageIndex -lt 40 -and -not $closeReply; $messageIndex++) {
    $next = $Stream.ReadByte()
    if ($next -lt 0) { throw "RCH ha chiuso la connessione prima dell'esito della chiusura Fidelity." }
    if ($next -eq 0x06) {
      $ackCount++
      if ($ackCount -eq 1) { $paymentAcknowledged = $true }
      else { $closeAcknowledged = $true }
      continue
    }
    if ($next -eq 0x15) { throw "RCH ha rifiutato il pagamento o la chiusura Fidelity (NACK)." }
    $frame = Read-RchFrame -Stream $Stream -FirstByte $next
    $reply = ConvertFrom-RchFrame -Frame $frame -Acknowledged ($ackCount -gt 0)
    if ($frame.PacketId -eq $PaymentPacketId) {
      if ($reply.ErrorFamily -eq "P" -and $reply.Follows -eq "1") {
        Write-BridgeLog "RCH segnala fine carta durante il pagamento: sostituire il rotolo." "WARN"
        continue
      }
      Assert-RchSuccess -Reply $reply
      $paymentReply = $reply
      continue
    }
    if ($frame.PacketId -ne $ClosePacketId) { throw "Risposta RCH inattesa durante la chiusura Fidelity." }
    if ($reply.ErrorFamily -eq "P" -and $reply.Follows -eq "1") {
      Write-BridgeLog "RCH segnala fine carta durante la chiusura Fidelity: sostituire il rotolo." "WARN"
      continue
    }
    Assert-RchSuccess -Reply $reply
    $closeReply = $reply
  }
  if (-not $closeReply) { throw "RCH non ha confermato la chiusura Fidelity." }
  $paymentWasAcknowledged = $paymentAcknowledged -or [bool]$paymentReply -or [bool]$closeReply
  $paymentState = if ($paymentReply) { $paymentReply.DocumentState } else { "CHIUSO" }
  $closeWasAcknowledged = $closeAcknowledged -or [bool]$closeReply
  return [pscustomobject]@{
    PaymentAcknowledged = $paymentWasAcknowledged
    PaymentState = $paymentState
    CloseAcknowledged = $closeWasAcknowledged
    CloseState = $closeReply.DocumentState
  }
}

function Get-EpsonFiscalReference {
  param([string]$ResultText)
  $date = if ($ResultText -match '(?i)<fiscalReceiptDate>([^<]+)</fiscalReceiptDate>') { $Matches[1] -replace '[^0-9]', '' } else { [DateTime]::Now.ToString('ddMMyyyy') }
  $closure = if ($ResultText -match '(?i)<zRepNumber>0*([0-9]+)</zRepNumber>') { $Matches[1] } else { $null }
  $document = if ($ResultText -match '(?i)<fiscalReceiptNumber>0*([0-9]+)</fiscalReceiptNumber>') { $Matches[1] } else { $null }
  $serial = if ($ResultText -match '(?i)<fiscalSerialNumber>([^<]+)</fiscalSerialNumber>') { $Matches[1].Trim() } elseif ($script:Config.EpsonFiscalSerial) { [string]$script:Config.EpsonFiscalSerial } else { "POS" }
  if (-not $closure -or -not $document) { return $null }
  return @{ date = $date; closureNo = $closure; documentNo = $document; serial = $serial }
}

function Invoke-EpsonXmlDocument {
  param([object]$Job, [System.Collections.Generic.List[string]]$Rows, [string]$Suffix)
  if (-not (Test-Path -LiteralPath $script:Config.EpsonFpMatePath)) { throw "EpsonFpMate.exe non trovato nel percorso configurato." }
  New-Item -ItemType Directory -Force -Path $script:Config.WorkDirectory | Out-Null
  New-Item -ItemType Directory -Force -Path $script:Config.EpsonOutputDirectory | Out-Null
  $baseName = "msrt-$($Job.id)-$Suffix-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
  $inputPath = Join-Path $script:Config.WorkDirectory "$baseName.xml"
  [IO.File]::WriteAllLines($inputPath, $Rows, [Text.UTF8Encoding]::new($false))
  $argument = $inputPath
  if ($script:Config.EpsonSettingsPath) { $argument = "$($script:Config.EpsonSettingsPath)|$inputPath" }
  $process = Start-Process -FilePath $script:Config.EpsonFpMatePath -ArgumentList @($argument) -WorkingDirectory (Split-Path -Parent $script:Config.EpsonFpMatePath) -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "EpsonFpMate terminato con codice $($process.ExitCode)." }
  $timeout = if ($script:Config.ProcessingTimeoutSeconds) { [int]$script:Config.ProcessingTimeoutSeconds } else { 45 }
  $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
  $output = $null
  do {
    $output = Get-ChildItem -LiteralPath $script:Config.EpsonOutputDirectory -File | Where-Object { $_.Name -like "*$baseName*" } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $output) { Start-Sleep -Milliseconds 400 }
  } while (-not $output -and [DateTime]::UtcNow -lt $deadline)
  if (-not $output) { throw "EpsonFpMate non ha creato il file di esito. Abilitare Output File e disattivare il timestamp in EpsonFpMateConfig." }
  $resultText = Get-Content -LiteralPath $output.FullName -Raw
  if ($resultText -notmatch '(?i)(success\s*=\s*["'']true["'']|Result\s*=\s*["'']ok["'']|Result\s*[|:=]\s*ok)') {
    throw "EpsonFpMate ha restituito un esito KO: $($resultText.Substring(0, [Math]::Min(1000, $resultText.Length)))"
  }
  return @{ outputFile = $output.Name; result = ($resultText.Substring(0, [Math]::Min(2500, $resultText.Length))); fiscalReference = (Get-EpsonFiscalReference $resultText) }
}

function Add-EpsonPayments {
  param([System.Collections.Generic.List[string]]$Rows, [object[]]$Payments, [double]$AdditionalCash, [int]$Operator)
  $effective = New-Object System.Collections.Generic.List[object]
  if ($AdditionalCash -gt 0) { $effective.Add([pscustomobject]@{ method = 'cash'; description = 'CREDITO RESO'; amount = $AdditionalCash; epsonMode = 0 }) }
  foreach ($payment in $Payments) { if ([double]$payment.amount -gt 0) { $effective.Add($payment) } }
  foreach ($payment in $effective) {
    $mode = [int]$payment.epsonMode
    $index = 1
    if ($script:Config.EpsonPaymentIndexes -and $script:Config.EpsonPaymentIndexes.($payment.method)) { $index = [int]$script:Config.EpsonPaymentIndexes.($payment.method) }
    $description = Escape-Xml ([string]$payment.description)
    $Rows.Add("  <printRecTotal operator=`"$Operator`" description=`"$description`" payment=`"$(Format-ItalianNumber ([double]$payment.amount))`" paymentType=`"$mode`" index=`"$index`" justification=`"1`" />")
  }
}

function Invoke-EpsonFpMate {
  param([object]$Job)
  $payload = $Job.payload
  $operator = if ($script:Config.EpsonOperator) { [int]$script:Config.EpsonOperator } else { 1 }
  $department = if ($script:Config.EpsonDepartment) { [int]$script:Config.EpsonDepartment } else { 1 }
  $returnLines = @($payload.lines | Where-Object { [double]$_.quantity -lt 0 -or [string]$_.itemType -eq 'return' })
  $saleLines = @($payload.lines | Where-Object { [double]$_.quantity -gt 0 -and [string]$_.itemType -ne 'return' })
  $results = New-Object System.Collections.Generic.List[object]

  if ($returnLines.Count) {
    $reference = $payload.originalFiscalReference
    if (-not $reference -or -not $reference.date -or -not $reference.closureNo -or -not $reference.documentNo -or -not $reference.serial) {
      throw "Reso Epson non inviato: mancano data, chiusura, documento o matricola fiscale originali."
    }
    $date = ([string]$reference.date) -replace '[^0-9]', ''
    $rows = New-Object System.Collections.Generic.List[string]
    $rows.Add('<?xml version="1.0" encoding="utf-8"?>')
    $rows.Add('<printerFiscalReceipt>')
    $rows.Add("  <printRecMessage operator=`"$operator`" message=`"REFUND $(([int]$reference.closureNo).ToString('0000')) $(([int]$reference.documentNo).ToString('0000')) $date $(Escape-Xml ([string]$reference.serial) 11)`" messageType=`"4`" />")
    $rows.Add("  <beginFiscalReceipt operator=`"$operator`" />")
    $returnTotal = 0.0
    foreach ($line in $returnLines) {
      $quantity = [math]::Abs([double]$line.quantity)
      $effectiveUnit = [math]::Round([math]::Abs([double]$line.lineTotal) / $quantity, 2)
      $returnTotal += $effectiveUnit * $quantity
      $rows.Add("  <printRecRefund operator=`"$operator`" description=`"$(Escape-Xml ([string]$line.description))`" quantity=`"$(Format-ItalianNumber $quantity)`" unitPrice=`"$(Format-ItalianNumber $effectiveUnit)`" department=`"$department`" justification=`"1`" />")
    }
    $rows.Add("  <printRecSubtotal operator=`"$operator`" option=`"0`" />")
    $rows.Add("  <printRecTotal operator=`"$operator`" description=`"CONTANTI`" payment=`"$(Format-ItalianNumber $returnTotal)`" paymentType=`"0`" index=`"1`" justification=`"1`" />")
    $rows.Add("  <endFiscalReceipt operator=`"$operator`" />")
    $rows.Add('</printerFiscalReceipt>')
    $results.Add((Invoke-EpsonXmlDocument -Job $Job -Rows $rows -Suffix 'refund'))
  }

  if ($saleLines.Count) {
    $rows = New-Object System.Collections.Generic.List[string]
    $rows.Add('<?xml version="1.0" encoding="utf-8"?>')
    $rows.Add('<printerFiscalReceipt>')
    $rows.Add("  <beginFiscalReceipt operator=`"$operator`" />")
    foreach ($line in $saleLines) {
      $quantity = [double]$line.quantity
      $effectiveUnit = [math]::Round(([double]$line.lineTotal / $quantity), 2)
      if ([string]$line.itemType -eq 'reservation_balance' -and $line.metadata.totalPrice) {
        $fullAmount = [double]$line.metadata.totalPrice
        $deposit = [math]::Max(0, $fullAmount - [double]$line.lineTotal)
        $rows.Add("  <printRecItem operator=`"$operator`" description=`"$(Escape-Xml ([string]$line.description))`" quantity=`"1`" unitPrice=`"$(Format-ItalianNumber $fullAmount)`" department=`"$department`" justification=`"1`" />")
        if ($deposit -gt 0) { $rows.Add("  <printRecItemAdjustment operator=`"$operator`" description=`"ACCONTO GIA RISCOSSO`" adjustmentType=`"10`" amount=`"$(Format-ItalianNumber $deposit)`" department=`"$department`" justification=`"1`" />") }
      } else {
        $description = if ([string]$line.itemType -in @('deposit','repair_deposit')) { 'ACCONTO' } else { [string]$line.description }
        $rows.Add("  <printRecItem operator=`"$operator`" description=`"$(Escape-Xml $description)`" quantity=`"$(Format-ItalianNumber $quantity)`" unitPrice=`"$(Format-ItalianNumber $effectiveUnit)`" department=`"$department`" justification=`"1`" />")
      }
    }
    $rows.Add("  <printRecSubtotal operator=`"$operator`" option=`"0`" />")
    $returnCredit = [math]::Round(($returnLines | ForEach-Object { [math]::Abs([double]$_.lineTotal) } | Measure-Object -Sum).Sum, 2)
    Add-EpsonPayments -Rows $rows -Payments @($payload.payments) -AdditionalCash $returnCredit -Operator $operator
    $rows.Add("  <endFiscalReceipt operator=`"$operator`" />")
    $rows.Add('</printerFiscalReceipt>')
    $results.Add((Invoke-EpsonXmlDocument -Job $Job -Rows $rows -Suffix 'sale'))
  }
  if (-not $results.Count) { throw "La richiesta Epson non contiene righe fiscali stampabili." }
  $last = $results[$results.Count - 1]
  return @{ adapter = 'epson_fpmate'; receiptNo = [string]$payload.receiptNo; documents = $results; fiscalReference = $last.fiscalReference; result = 'confirmed' }
}

function Invoke-RchRawCommand {
  param([System.IO.Stream]$Stream, [string]$Command, [char]$PacketId)
  [byte[]]$packet = New-RchPacket -Data $Command -PacketId $PacketId
  $Stream.Write($packet, 0, $packet.Length)
  $Stream.Flush()
  $first = $Stream.ReadByte()
  if ($first -eq 0x15) { throw "Errore Cassa RCH" }
  if ($first -eq 0x06) { $first = $Stream.ReadByte() }
  if ($first -lt 0) { throw "RCH non ha restituito alcuna risposta." }
  $frame = Read-RchFrame -Stream $Stream -FirstByte $first
  if ($frame.PacketId -ne $PacketId) { throw "Risposta RCH associata a un pacchetto differente." }
  return [string]$frame.Data
}

function Get-RchFiscalReference {
  param([System.IO.Stream]$Stream, [int]$PacketOffset)
  try {
    $status = Invoke-RchRawCommand -Stream $Stream -Command '<</?s' -PacketId ([char](48 + ($PacketOffset % 10)))
    $closure = Invoke-RchRawCommand -Stream $Stream -Command '<</?7' -PacketId ([char](48 + (($PacketOffset + 1) % 10)))
    $serial = Invoke-RchRawCommand -Stream $Stream -Command '<</?m' -PacketId ([char](48 + (($PacketOffset + 2) % 10)))
    $documentNo = if ($status -match 'N0*([0-9]{1,4})$') { $Matches[1] } elseif ($status -match '0*([0-9]{1,4})$') { $Matches[1] } else { $null }
    $closureNo = if ($closure -match '0*([0-9]{1,4})$') { $Matches[1] } else { $null }
    $serialNo = if ($serial -match '([A-Z0-9]{11})') { $Matches[1] } else { $null }
    if (-not $documentNo -or -not $closureNo) { return $null }
    return @{ date = [DateTime]::Now.ToString('ddMMyy'); closureNo = $closureNo; documentNo = $documentNo; serial = $serialNo }
  } catch {
    Write-BridgeLog "Documento stampato ma riferimenti fiscali non letti: $($_.Exception.Message)" "WARN"
    return $null
  }
}

function Add-RchPayments {
  param([System.Collections.Generic.List[string]]$Commands, [object[]]$Payments, [double]$AdditionalCash, [long]$TargetCents)
  $amounts = @{}
  if ($AdditionalCash -gt 0) { $amounts.cash = ConvertTo-RchCents $AdditionalCash }
  foreach ($payment in $Payments) {
    $amount = ConvertTo-RchCents ([double]$payment.amount)
    if ($amount -le 0) { continue }
    $method = [string]$payment.method
    $amounts[$method] = ([long]($amounts[$method])) + $amount
  }
  $sum = [long](($amounts.Values | Measure-Object -Sum).Sum)
  if ($sum -ne $TargetCents) { throw "La somma dei pagamenti RCH non coincide con il totale del documento." }
  if ($amounts.Count -eq 1 -and [long]$amounts.cash -eq $TargetCents) { $Commands.Add('=T1'); return }
  if ($amounts.Count -eq 1 -and [long]$amounts.card -eq $TargetCents) { $Commands.Add('=T4'); return }
  if ($amounts.Count -eq 2 -and $amounts.ContainsKey('cash') -and $amounts.ContainsKey('card')) {
    $Commands.Add("=T1/`$$([long]$amounts.cash)")
    $Commands.Add('=T4')
    return
  }
  $order = @('gift','cash','bank','card')
  foreach ($method in $order) {
    if (-not $amounts.ContainsKey($method) -or [long]$amounts[$method] -le 0) { continue }
    $property = if ($script:Config.RchPaymentIndexes) { $script:Config.RchPaymentIndexes.PSObject.Properties[$method] } else { $null }
    if (-not $property) { throw "Pagamento RCH non configurato: $method." }
    $index = [int]$property.Value
    $Commands.Add("=T$index/`$$([long]$amounts[$method])")
  }
}

function Invoke-RchStandardTcp {
  param([object]$Job)
  $payload = $Job.payload
  $hostName = [string]$script:Config.RchHost
  $port = if ($script:Config.RchPort) { [int]$script:Config.RchPort } else { 23 }
  $department = if ($script:Config.RchDepartment) { [int]$script:Config.RchDepartment } else { 1 }
  if ($department -lt 1 -or $department -gt 99) { throw "Reparto RCH non valido: $department." }
  $commands = New-Object System.Collections.Generic.List[string]
  $returnLines = @($payload.lines | Where-Object { [double]$_.quantity -lt 0 -or [string]$_.itemType -eq 'return' })
  $saleLines = @($payload.lines | Where-Object { [double]$_.quantity -gt 0 -and [string]$_.itemType -ne 'return' })
  $fidelityEnabled = if ($null -ne $script:Config.RchFidelityEnabled) { [bool]$script:Config.RchFidelityEnabled } else { $true }

  if ($returnLines.Count) {
    $reference = $payload.originalFiscalReference
    if (-not $reference -or -not $reference.date -or -not $reference.closureNo -or -not $reference.documentNo) {
      throw "Reso RCH non inviato: mancano data, numero chiusura o numero documento originali."
    }
    $date = (([string]$reference.date) -replace '[^0-9]', '')
    if ($date.Length -eq 8) { $date = $date.Substring(0,4) + $date.Substring(6,2) }
    $commands.Add("=r/&$date/[$([int]$reference.closureNo)/]$([int]$reference.documentNo)")
    foreach ($line in $returnLines) {
      $quantity = [math]::Abs([double]$line.quantity)
      $unitPriceCents = ConvertTo-RchCents ([math]::Abs([double]$line.lineTotal) / $quantity)
      $commands.Add("=R$department/`$$unitPriceCents/*$(Format-RchQuantity $quantity)/($(ConvertTo-RchDescription ([string]$line.description)))")
    }
    $commands.Add('=T1')
    if ($fidelityEnabled) { $commands.Add('=c') }
  }

  $saleTotalCents = 0L
  foreach ($line in $saleLines) {
    $quantity = [double]$line.quantity
    if ([string]$line.itemType -eq 'reservation_balance' -and $line.metadata.totalPrice) {
      $fullCents = ConvertTo-RchCents ([double]$line.metadata.totalPrice)
      $depositCents = [math]::Max(0, $fullCents - (ConvertTo-RchCents ([double]$line.lineTotal)))
      $commands.Add("=R$department/`$$fullCents/($(ConvertTo-RchDescription ([string]$line.description)))")
      if ($depositCents -gt 0) { $commands.Add("=R$department/`$$depositCents/&2/(ACCONTO)") }
      $saleTotalCents += $fullCents - $depositCents
    } else {
      $unitPriceCents = ConvertTo-RchCents ([double]$line.lineTotal / $quantity)
      $description = if ([string]$line.itemType -in @('deposit','repair_deposit')) { 'ACCONTO' } else { ConvertTo-RchDescription ([string]$line.description) }
      $commands.Add("=R$department/`$$unitPriceCents/*$(Format-RchQuantity $quantity)/($description)")
      $saleTotalCents += ConvertTo-RchCents ([double]$line.lineTotal)
    }
  }
  if ($saleLines.Count) {
    $commands.Add('=S')
    $adjustmentCents = if ($returnLines.Count) { 0L } else { ConvertTo-RchCents ([double]$payload.adjustment) }
    if ($adjustmentCents -lt 0) { $commands.Add("=V-/`$$([Math]::Abs($adjustmentCents))/(SCONTO TOTALE)") }
    elseif ($adjustmentCents -gt 0) { $commands.Add("=V+/`$$adjustmentCents/(MAGGIORAZIONE TOTALE)") }
    $saleTotalCents += $adjustmentCents
    $returnCredit = [math]::Round(($returnLines | ForEach-Object { [math]::Abs([double]$_.lineTotal) } | Measure-Object -Sum).Sum, 2)
    Add-RchPayments -Commands $commands -Payments @($payload.payments) -AdditionalCash $returnCredit -TargetCents $saleTotalCents
    if ($fidelityEnabled) { $commands.Add('=c') }
  }
  if (-not $commands.Count) { throw "Lo scontrino RCH non contiene comandi stampabili." }

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connectTimeout = if ($script:Config.RchConnectTimeoutMilliseconds) { [int]$script:Config.RchConnectTimeoutMilliseconds } else { 5000 }
    $pending = $client.BeginConnect($hostName, $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($connectTimeout, $false)) { throw "Timeout collegamento RCH a ${hostName}:$port." }
    $client.EndConnect($pending)
    $client.NoDelay = $true
    $stream = $client.GetStream()
    $stream.ReadTimeout = if ($script:Config.RchResponseTimeoutSeconds) { [int]$script:Config.RchResponseTimeoutSeconds * 1000 } else { 60000 }
    $stream.WriteTimeout = 10000
    $responses = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $commands.Count; $index++) {
      $packetId = [char](48 + ($index % 10))
      if ($fidelityEnabled -and $index + 1 -lt $commands.Count -and $commands[$index] -match '^=T' -and $commands[$index + 1] -eq "=c") {
        $closePacketId = [char](48 + (($index + 1) % 10))
        $fidelity = Invoke-RchFidelityClose -Stream $stream -PaymentCommand $commands[$index] -PaymentPacketId $packetId -ClosePacketId $closePacketId
        $responses.Add([pscustomobject]@{ sequence = $index + 1; acknowledged = $fidelity.PaymentAcknowledged; documentState = $fidelity.PaymentState })
        $responses.Add([pscustomobject]@{ sequence = $index + 2; acknowledged = $fidelity.CloseAcknowledged; documentState = $fidelity.CloseState })
        $index++
        continue
      }
      $reply = Invoke-RchCommand -Stream $stream -Command $commands[$index] -PacketId $packetId
      $responses.Add([pscustomobject]@{ sequence = $index + 1; acknowledged = $reply.Acknowledged; documentState = $reply.DocumentState })
    }
    $fiscalReference = Get-RchFiscalReference -Stream $stream -PacketOffset $commands.Count
    return @{
      adapter = "rch_standard_tcp"
      endpoint = "${hostName}:$port"
      protocol = "Standard N"
      receiptNo = [string]$payload.receiptNo
      commands = $commands.Count
      responses = $responses
      fiscalReference = $fiscalReference
      result = "confirmed"
    }
  } finally {
    $client.Close()
  }
}

function Receive-LocalWebSocketJson {
  param([System.Net.WebSockets.WebSocket]$Socket)
  [byte[]]$buffer = New-Object byte[] 4096
  $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$buffer)
  $memory = New-Object IO.MemoryStream
  try {
    do {
      $result = $Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { return $null }
      if ($result.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text) { throw "Il ponte locale accetta soltanto messaggi JSON di testo." }
      if ($result.Count -gt 0) { $memory.Write($buffer, 0, $result.Count) }
      if ($memory.Length -gt 65536) { throw "Richiesta locale troppo grande." }
    } while (-not $result.EndOfMessage)
    $json = [Text.Encoding]::UTF8.GetString($memory.ToArray())
    if ([string]::IsNullOrWhiteSpace($json)) { throw "Richiesta locale vuota." }
    return ($json | ConvertFrom-Json)
  } finally {
    $memory.Dispose()
  }
}

function Send-LocalWebSocketJson {
  param([System.Net.WebSockets.WebSocket]$Socket, [object]$Value)
  $json = $Value | ConvertTo-Json -Depth 20 -Compress
  [byte[]]$bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$bytes)
  $Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Complete-FiscalJobWithRetry {
  param([object]$Job, [object]$Result)
  $lastError = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Invoke-BridgeApi -Method Post -Path "/api/fiscal" -Body @{ action = "complete"; store = $script:Config.Store; jobId = $Job.id; response = $Result } | Out-Null
      return
    } catch {
      $lastError = $_.Exception.Message
      if ($attempt -lt 5) { Start-Sleep -Seconds ([Math]::Min(10, $attempt * 2)) }
    }
  }
  throw "Scontrino stampato, ma conferma al gestionale non riuscita. NON RISTAMPARE. Dettaglio: $lastError"
}

function Invoke-TicketedFiscalPrint {
  param([object]$Request)
  $requestedStore = [string]$Request.store
  if ($requestedStore -ne [string]$script:Config.Store) { return @{ ok = $false; code = "STORE_MISMATCH"; error = "Il ponte locale appartiene a un altro negozio." } }
  $ticket = [string]$Request.ticket
  if ([string]::IsNullOrWhiteSpace($ticket) -or $ticket.Length -gt 160) { return @{ ok = $false; code = "INVALID_TICKET"; error = "Ticket fiscale locale non valido." } }

  $job = $null
  try {
    $claim = Invoke-BridgeApi -Method Post -Path "/api/fiscal" -Body @{ action = "claimTicket"; store = $script:Config.Store; ticket = $ticket }
    if (-not $claim.job) { throw "Il gestionale non ha restituito una richiesta fiscale." }
    $job = $claim.job
    if ($script:Config.Adapter -eq "epson_fpmate") { $result = Invoke-EpsonFpMate $job }
    elseif ($script:Config.Adapter -eq "rch_standard_tcp") { $result = Invoke-RchStandardTcp $job }
    else { throw "Adapter non supportato: $($script:Config.Adapter)" }
    Complete-FiscalJobWithRetry -Job $job -Result $result
    Write-BridgeLog "Scontrino $($job.payload.receiptNo) completato dopo conferma Firebase."
    return @{ ok = $true; jobId = $job.id; receiptNo = [string]$job.payload.receiptNo; result = $result }
  } catch {
    $message = $_.Exception.Message
    $confirmationPending = $message -like "Scontrino stampato, ma conferma al gestionale non riuscita*"
    if ($job -and -not $confirmationPending) {
      try { Invoke-BridgeApi -Method Post -Path "/api/fiscal" -Body @{ action = "fail"; store = $script:Config.Store; jobId = $job.id; error = $message } | Out-Null }
      catch { Write-BridgeLog "Impossibile registrare sul gestionale l'errore della richiesta $($job.id): $($_.Exception.Message)" "WARN" }
    }
    Write-BridgeLog "Errore stampa locale: $message" "ERROR"
    if ($message -match '(?i)NACK|Errore Cassa RCH') { return @{ ok = $false; code = "RCH_NACK"; error = "Errore Cassa RCH" } }
    if ($confirmationPending) { return @{ ok = $false; code = "CONFIRMATION_PENDING"; error = $message } }
    return @{ ok = $false; code = "FISCAL_PRINT_ERROR"; error = $message }
  }
}

function Start-LocalWebSocketBridge {
  $port = if ($script:Config.LocalWebSocketPort) { [int]$script:Config.LocalWebSocketPort } else { 8080 }
  if ($port -lt 1 -or $port -gt 65535) { throw "Porta WebSocket locale non valida: $port." }
  $prefix = "http://localhost:$port/"
  $allowedOrigin = ([string]$script:Config.ApiBaseUrl).TrimEnd('/')
  $listener = New-Object Net.HttpListener
  $listener.Prefixes.Add($prefix)
  $listener.Start()
  Write-BridgeLog "WebSocket fiscale locale attivo su ws://localhost:$port per $($script:Config.Store)."
  try {
    while ($listener.IsListening) {
      $context = $listener.GetContext()
      $socket = $null
      try {
        $origin = [string]$context.Request.Headers['Origin']
        if ($origin.TrimEnd('/') -ne $allowedOrigin) {
          $context.Response.StatusCode = 403
          $context.Response.Close()
          continue
        }
        if (-not $context.Request.IsWebSocketRequest) {
          $context.Response.StatusCode = 400
          $context.Response.Close()
          continue
        }
        $webSocketContext = $context.AcceptWebSocketAsync($null).GetAwaiter().GetResult()
        $socket = $webSocketContext.WebSocket
        $request = Receive-LocalWebSocketJson -Socket $socket
        if (-not $request) { continue }
        if ([string]$request.action -eq "ping") {
          if ([string]$request.store -ne [string]$script:Config.Store) { $response = @{ ok = $false; code = "STORE_MISMATCH"; error = "Ponte configurato per un altro negozio." } }
          else {
            Invoke-BridgeApi -Method Post -Path "/api/fiscal" -Body @{ action = "heartbeat"; store = $script:Config.Store; status = "online"; error = "" } | Out-Null
            $response = @{ ok = $true; store = [string]$script:Config.Store; adapter = [string]$script:Config.Adapter }
          }
        } elseif ([string]$request.action -eq "printFiscalReceipt") {
          $response = Invoke-TicketedFiscalPrint -Request $request
        } else {
          $response = @{ ok = $false; code = "INVALID_ACTION"; error = "Operazione locale non disponibile." }
        }
        Send-LocalWebSocketJson -Socket $socket -Value $response
      } catch {
        Write-BridgeLog "Richiesta WebSocket locale non riuscita: $($_.Exception.Message)" "WARN"
        if ($socket -and $socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
          try { Send-LocalWebSocketJson -Socket $socket -Value @{ ok = $false; code = "LOCAL_BRIDGE_ERROR"; error = $_.Exception.Message } } catch {}
        }
      } finally {
        if ($socket) {
          try {
            if ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) { $socket.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "Operazione conclusa", [Threading.CancellationToken]::None).GetAwaiter().GetResult() }
          } catch {}
          $socket.Dispose()
        }
      }
    }
  } finally {
    $listener.Stop()
    $listener.Close()
  }
}

if ($SelfTest) {
  $script:Config = [pscustomobject]@{ RchAddress = "01" }
  [byte[]]$testPacket = New-RchPacket -Data "=T1" -PacketId ([char]'0')
  $expected = "02-30-31-30-30-33-4E-3D-54-31-30-31-36-03"
  if ([BitConverter]::ToString($testPacket) -ne $expected) { throw "Autotest creazione pacchetto RCH non superato." }
  [byte[]]$fidelityPacket = New-RchPacket -Data "=c" -PacketId ([char]'1')
  if ([BitConverter]::ToString($fidelityPacket) -ne "02-30-31-30-30-32-4E-3D-63-31-31-30-03") { throw "Autotest chiusura Fidelity RCH non superato." }
  [byte[]]$testResponse = New-RchPacket -Data "ON00000000" -PacketId ([char]'0')
  $memory = New-Object IO.MemoryStream(,$testResponse)
  try {
    $frame = Read-RchFrame -Stream $memory -FirstByte ($memory.ReadByte())
    if ($frame.Data -ne "ON00000000" -or $frame.PacketId -ne '0') { throw "Autotest lettura risposta RCH non superato." }
  } finally { $memory.Dispose() }
  Write-Host "Autotest Protocollo Standard RCH completato."
  exit 0
}

$script:Config = Read-BridgeConfig
if ($Config.Store -notin @("Viterbo", "Gran Sasso")) { throw "Store deve essere Viterbo o Gran Sasso." }
$mutexName = "MarinelliRTBridge_$($Config.Store -replace '[^A-Za-z0-9]', '_')"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0, $false) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) { throw "Il ponte $($Config.Store) e gia avviato su questo PC." }
Write-BridgeLog "Ponte RT avviato: $($Config.Store) / $($Config.Adapter)"

if ($Config.Adapter -eq "rch_standard_tcp") {
  $rchPort = if ($Config.RchPort) { [int]$Config.RchPort } else { 23 }
  Test-TcpEndpoint -HostName ([string]$Config.RchHost) -Port $rchPort | Out-Null
  Write-BridgeLog "RCH raggiungibile via TCP: $($Config.RchHost):$rchPort / Protocollo Standard. Nessun comando inviato durante il test."
} elseif ($Config.Adapter -eq "epson_fpmate") {
  if (-not (Test-Path -LiteralPath $Config.EpsonFpMatePath)) { throw "EpsonFpMate.exe non trovato nel percorso configurato." }
  Write-BridgeLog "EpsonFpMate disponibile: $($Config.EpsonFpMatePath)."
}

try {
  Start-LocalWebSocketBridge
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

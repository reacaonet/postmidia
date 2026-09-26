<#
.SYNOPSIS
  Executa o E2E do postmidia sem serbloqueado pelo runner que chamou.

.DESCRIPTION
  verify-e2e.sh precisa de Git Bash (WSL nao alcanca o loopback do Windows) e
  deixa server e worker em background. Quando o script e chamado direto de uma
  ferramenta, tres coisas quebram:

    1. Os filhos herdam stdout/stderr da chamada, que so fecha quando o script
       termina. O runner espera o pipe e mata a arvore no meio da execucao.
    2. O runner nao espera o processo Git Bash encerrar, entao o log em stdout
       se perde mesmo com o teste concluido.
    3. Um 422k de argumentos ou um /tmp do Git Bash lido por node nativo do
       Windows.matam o script antes da validacao.

  Este runner resolve os tres: Start-Process desanexa os pipes, o log vai para
  arquivo, a execucao e esperada por polling do arquivo e a limpeza dos orfaos
  acontece aqui. verify-e2e.sh continua sendo a fonte da verdade dos testes.

.EXAMPLE
  pwsh -File scripts/run-e2e.ps1
#>
[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 300,
  [int]$Port = 8601
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$gitBash = 'C:\Program Files\Git\bin\bash.exe'
$script = Join-Path $repoRoot 'scripts\verify-e2e.sh'
$log = Join-Path ([System.IO.Path]::GetTempPath()) 'postmidia-e2e.log'

if (-not (Test-Path -LiteralPath $gitBash)) {
  throw "Git Bash nao encontrado em $gitBash"
}
if (-not (Test-Path -LiteralPath $script)) {
  throw "verify-e2e.sh nao encontrado em $script"
}

function Stop-E2EOrphans {
  param([int]$ListenPort)

  $listeners = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Write-Host "[run-e2e] liberando porta $ListenPort (pid $($listener.OwningProcess))"
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }

  # Workers e servidores sem listener (worker nao abre porta) tambem ficam.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'postmidia' -and $_.CommandLine -match 'server\.ts|worker\.ts|verify-e2e' } |
    ForEach-Object {
      Write-Host "[run-e2e] encerrando orfao $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

  Start-Sleep -Seconds 2
}

function Invoke-E2E {
  param([string]$BashExe, [string]$WorkDir, [string]$LogPath)

  if (Test-Path -LiteralPath $LogPath) {
    Remove-Item -LiteralPath $LogPath -Force
  }

  # -RedirectStandard* e essential: sem isso os filhos herdam o pipe do runner.
  $unixRoot = ($WorkDir -replace '\\', '/') -replace ' ', '\ '
  $inner = "cd '$unixRoot' && ./scripts/verify-e2e.sh"

  # PowerShell 5.1 junta -ArgumentList com espacos e nao cita elementos com
  # espaco, entao o comando do bash precisa vir entre aspas explicitamente.
  # Sem isso o bash recebe so "cd" como string de comando e nao roda nada.
  $process = Start-Process -FilePath $BashExe `
    -ArgumentList '-lc', "`"$inner`"" `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError "$LogPath.err" `
    -WindowStyle Hidden `
    -PassThru

  return $process
}

Stop-E2EOrphans -ListenPort $Port

Write-Host "[run-e2e] iniciando (log: $log)"
$process = Invoke-E2E -BashExe $gitBash -WorkDir $repoRoot -LogPath $log

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$finished = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $log) {
    $content = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match 'RESULTADO: \d+ ok, \d+ falhas') {
      $finished = $true
      break
    }
  }
  if ($process.HasExited -and -not $finished) {
    # Saiu sem imprimir RESULTADO: o script morreu no meio.
    break
  }
  Start-Sleep -Seconds 4
}

# O log e lido antes de qualquer limpeza, senao o orfao segura o arquivo.
if (Test-Path -LiteralPath $log) {
  Get-Content -LiteralPath $log
} else {
  Write-Host "[run-e2e] nenhum log foi produzido"
}

if (Test-Path -LiteralPath "$log.err") {
  $stderr = Get-Content -LiteralPath "$log.err" -Raw
  if ($stderr -and $stderr.Trim() -ne '') {
    Write-Host ""
    Write-Host "--- stderr ---"
    Write-Host $stderr
  }
}

Stop-E2EOrphans -ListenPort $Port

if (-not $finished) {
  Write-Host "[run-e2e] TIMEOUT ou execucao interrompida apos ${TimeoutSeconds}s"
  exit 1
}

$content = Get-Content -LiteralPath $log -Raw
if ($content -match 'RESULTADO: (\d+) ok, (\d+) falhas') {
  $failures = [int]$Matches[2]
  Write-Host ""
  Write-Host "[run-e2e] $($Matches[1]) ok, $failures falhas"
  exit ($(if ($failures -eq 0) { 0 } else { 1 }))
}

exit 1

param(
  [string]$InstallRoot = 'C:\CodexOffline',
  [int]$TimeoutSeconds = 90,
  [int]$DebugPort = 9222,
  [string]$ArtifactDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $ArtifactDirectory) {
  $TemporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
  $ArtifactDirectory = Join-Path $TemporaryRoot 'codex-portable-smoke'
}

$Executable = Join-Path $InstallRoot 'app\ChatGPT.exe'
$Cli = Join-Path $InstallRoot 'app\resources\codex.exe'
$UserData = Join-Path $ArtifactDirectory 'user-data'
$CodexHome = Join-Path $ArtifactDirectory 'codex-home'
$StdoutLog = Join-Path $ArtifactDirectory 'stdout.log'
$StderrLog = Join-Path $ArtifactDirectory 'stderr.log'
$ElectronLog = Join-Path $ArtifactDirectory 'electron.log'
$TargetsPath = Join-Path $ArtifactDirectory 'cdp-targets.json'
$ResultPath = Join-Path $ArtifactDirectory 'smoke-result.json'

New-Item -ItemType Directory -Force -Path $ArtifactDirectory, $UserData, $CodexHome | Out-Null

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Portable executable was not found: $Executable"
}
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) {
  throw "Bundled Codex CLI was not found: $Cli"
}

$env:CODEX_SPARKLE_ENABLED = 'false'
$env:CODEX_CLI_PATH = $Cli
$env:CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE = '1'
$env:CODEX_HOME = $CodexHome
$env:ELECTRON_ENABLE_LOGGING = '1'
$env:ELECTRON_LOG_FILE = $ElectronLog

$StartedAt = Get-Date
$Failure = $null
$PageTarget = $null
$Process = $null

function Get-PortableProcesses {
  $Prefix = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

try {
  $Arguments = @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$UserData",
    '--disable-gpu'
  )
  $Process = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path $Executable) `
    -ArgumentList $Arguments -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 2
    try {
      $Targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 3)
      $PageTarget = $Targets | Where-Object {
        $_.type -eq 'page' -and $_.url -notlike 'devtools://*'
      } | Select-Object -First 1
      if ($PageTarget) {
        $Targets | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $TargetsPath -Encoding utf8
        break
      }
    } catch {
      # The DevTools endpoint is unavailable while Electron is still booting.
    }

    if ((Get-PortableProcesses).Count -eq 0) {
      throw 'All portable Codex processes exited before a renderer page was created.'
    }
  } while ((Get-Date) -lt $Deadline)

  if (-not $PageTarget) {
    throw "Portable Codex did not create a renderer page within $TimeoutSeconds seconds."
  }

  Start-Sleep -Seconds 5
  if ((Get-PortableProcesses).Count -eq 0) {
    throw 'Portable Codex exited immediately after creating its renderer page.'
  }

  $LogText = @($StdoutLog, $StderrLog, $ElectronLog) | ForEach-Object {
    if (Test-Path -LiteralPath $_) { Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue }
  } | Out-String
  $FatalPattern = 'ChatGPT failed to start|Desktop bootstrap failed to start|does not have package identity|no package identity|该进程没有程序包标识符|不能访问网络位置'
  if ($LogText -match $FatalPattern) {
    throw "A known package-identity startup failure was found in the logs: $($Matches[0])"
  }
} catch {
  $Failure = $_
} finally {
  $PortableProcesses = Get-PortableProcesses
  $Result = [ordered]@{
    success = ($null -eq $Failure -and $null -ne $PageTarget)
    startedAt = $StartedAt.ToUniversalTime().ToString('o')
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    executable = $Executable
    installRoot = $InstallRoot
    processIds = @($PortableProcesses | ForEach-Object { $_.ProcessId })
    pageTitle = if ($PageTarget) { $PageTarget.title } else { $null }
    pageUrl = if ($PageTarget) { $PageTarget.url } else { $null }
    error = if ($Failure) { $Failure.Exception.Message } else { $null }
  }
  $Result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ResultPath -Encoding utf8
  $Result | ConvertTo-Json -Depth 10 | Write-Host

  foreach ($PortableProcess in $PortableProcesses) {
    & taskkill.exe /PID $PortableProcess.ProcessId /T /F 2>&1 | Write-Host
  }
}

if ($Failure) { throw $Failure }
Write-Host 'Portable Codex created a renderer page and remained running.'

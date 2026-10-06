param([int]$Port = 18789)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$stateRoot = Join-Path $projectRoot 'validation/code-server'
$runtimeRoot = Join-Path $stateRoot 'code-server-4.140.0-windows-amd64'
$runtimeNode = Join-Path $runtimeRoot 'lib/node.exe'
if (!(Test-Path -LiteralPath $runtimeNode)) { throw 'Download and extract the verified Windows code-server build first. See validation/code-server/README.md.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already occupied. Stop the existing server first." }
& $runtimeNode (Join-Path $PSScriptRoot 'patch-vscode-runtime.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Runtime compatibility patch failed.' }
$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $runtimeNode
$processInfo.WorkingDirectory = $projectRoot
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.Environment['APPDATA'] = Join-Path $stateRoot 'roaming'
$processInfo.Environment['LOCALAPPDATA'] = Join-Path $stateRoot 'local'
foreach ($argument in @($runtimeRoot, '--config', (Join-Path $stateRoot 'config.yaml'), '--user-data-dir', (Join-Path $stateRoot 'user-data'), '--extensions-dir', (Join-Path $stateRoot 'extensions'), '--bind-addr', "127.0.0.1:$Port", '--auth', 'password', '--disable-telemetry', '--disable-update-check', '--disable-proxy')) {
  $processInfo.ArgumentList.Add($argument)
}
$serverProcess = [System.Diagnostics.Process]::Start($processInfo)
$serverProcess.Id | Set-Content -LiteralPath (Join-Path $stateRoot 'server.pid')
Write-Output "Started code-server PID $($serverProcess.Id) at http://127.0.0.1:$Port/"
Write-Output "Login password: $(Join-Path $stateRoot 'config.yaml')"

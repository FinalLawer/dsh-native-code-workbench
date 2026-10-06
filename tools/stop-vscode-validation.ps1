$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$stateRoot = Join-Path $projectRoot 'validation/code-server'
$pidFile = Join-Path $stateRoot 'server.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'No recorded validation server.'; return }
$serverId = [int](Get-Content -LiteralPath $pidFile)
$serverProcess = Get-Process -Id $serverId -ErrorAction SilentlyContinue
if (!$serverProcess) { Write-Output 'Validation server is already stopped.'; return }
$expectedNode = Join-Path $stateRoot 'code-server-4.140.0-windows-amd64/lib/node.exe'
if ([IO.Path]::GetFullPath($serverProcess.Path) -ne [IO.Path]::GetFullPath($expectedNode)) { throw 'Recorded PID does not belong to the validation runtime. Refusing to stop it.' }
& taskkill.exe /PID $serverId /T /F
if ($LASTEXITCODE -ne 0) { throw 'Could not stop validation server.' }

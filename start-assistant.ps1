<#
Purpose: Windows PowerShell launcher for the VibeCodingAssistant-ElonMa assistant startup flow.
Author: VibeCodingAssistant-ElonMa distribution tooling
#>

$ErrorActionPreference = "Stop"
$exitCode = 0

function Write-Stage {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Message
  )

  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-RequiredCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [string] $PreferredName = $Name
  )

  $command = Get-Command $PreferredName -ErrorAction SilentlyContinue
  if (-not $command) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
  }

  if (-not $command) {
    throw "$Name was not found in PATH. Install Node.js 18 or newer, then try again."
  }

  return $command
}

try {
  Set-Location -LiteralPath $PSScriptRoot

  Write-Host "VibeCodingAssistant-ElonMa Assistant Launcher" -ForegroundColor Green
  Write-Host "This launcher checks Node.js and npm, then runs npm run assistant:start."
  Write-Host "Preflight is executed by assistant:start before launch."

  Write-Stage "Checking required tools"
  $nodeCommand = Resolve-RequiredCommand -Name "node"
  $npmCommand = Resolve-RequiredCommand -Name "npm" -PreferredName "npm.cmd"

  Write-Host "Node.js: $($nodeCommand.Source)" -ForegroundColor DarkGray
  Write-Host "npm:     $($npmCommand.Source)" -ForegroundColor DarkGray

  Write-Stage "Starting assistant"
  & $npmCommand.Source run assistant:start
  $exitCode = $LASTEXITCODE

  Write-Host ""
  if ($exitCode -eq 0) {
    Write-Host "Assistant startup completed." -ForegroundColor Green
  } else {
    Write-Host "Assistant startup failed. Review the messages above." -ForegroundColor Red
  }
} catch {
  $exitCode = 1
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Write-Host ""
  Read-Host "Press Enter to close"
  exit $exitCode
}

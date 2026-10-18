<#
.SYNOPSIS
    Netarium Regression Test Runner (Phase 0)

.DESCRIPTION
    Runs the automated API regression test suite against a temporary isolated environment.
    No external dependencies required (pure PHP built-in features).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/run-tests.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Project root directory
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# Find PHP executable
$PhpPath = $null
$PhpCommand = Get-Command php -ErrorAction SilentlyContinue
if ($PhpCommand) {
    $PhpPath = $PhpCommand.Source
} elseif (Test-Path 'C:\php\php.exe') {
    $PhpPath = 'C:\php\php.exe'
} else {
    Write-Error "PHP executable not found. Please ensure PHP is in PATH or installed at C:\php\php.exe."
    exit 1
}

Write-Host "Starting Netarium Regression Tests..." -ForegroundColor Cyan
Write-Host "PHP: $PhpPath" -ForegroundColor DarkGray
Write-Host ""

$TestScript = Join-Path $ProjectRoot 'tests\regression_test.php'

& $PhpPath $TestScript

$ExitCode = $LASTEXITCODE

if ($ExitCode -eq 0) {
    Write-Host "`nAll regression tests completed successfully." -ForegroundColor Green
} else {
    Write-Host "`nRegression tests failed (Exit Code: $ExitCode)." -ForegroundColor Red
}

exit $ExitCode

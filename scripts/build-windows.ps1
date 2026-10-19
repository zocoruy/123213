param(
    [ValidateSet('All', 'Installer', 'Portable')]
    [string]$Target = 'All',
    [switch]$SkipInstall,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$RepositoryPath = Split-Path -Parent $PSScriptRoot
Push-Location $RepositoryPath

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

try {
    if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
        throw 'Run this script on Windows x64. Cross-platform packages need platform-specific sharp dependencies.'
    }
    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw 'This release targets Windows x64; use an x64 Windows build machine.'
    }
    if (-not $env:ELECTRON_BUILDER_COMPRESSION_LEVEL) {
        $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '5'
    }
    if (-not $SkipInstall) {
        Invoke-Checked 'npm.cmd' @('ci', '--include=optional', '--no-audit', '--no-fund')
    }
    # This catches missing native optional dependencies before packaging.
    Invoke-Checked 'node.exe' @('-e', "const s=require('sharp'); console.log('sharp',s.versions.sharp,'libvips',s.versions.vips)")
    if (-not $SkipTests) {
        Invoke-Checked 'npm.cmd' @('test')
    }
    Invoke-Checked 'npm.cmd' @('run', 'build')

    $BuildTargets = switch ($Target) {
        'Installer' { @('nsis') }
        'Portable' { @('portable') }
        default { @('nsis', 'portable') }
    }
    Invoke-Checked 'npm.cmd' (@('exec', '--', 'electron-builder', '--win') + $BuildTargets + @('--x64', '--publish', 'never'))

    $Checksums = Get-ChildItem -Path 'release' -Filter '*.exe' | Sort-Object Name | ForEach-Object {
        $Hash = Get-FileHash -Path $_.FullName -Algorithm SHA256
        "$($Hash.Hash.ToLowerInvariant())  $($_.Name)"
    }
    $Checksums | Set-Content -Path 'release/SHA256SUMS.txt' -Encoding utf8
    Write-Host 'Windows packages and SHA256SUMS.txt are in release/.'
}
finally {
    Pop-Location
}

# Installs the Security Engineer's scanners: pip-audit and bandit in their own environment, ~/.pae/tools/venv,
# and gitleaks (one program); only their three commands go in ~/.pae/tools/bin. The platform adds that folder (only it) to the end of
# the PATH of its Claude Code sessions, so a project's own python, pip and pytest are never replaced.
# Run again to upgrade them.
$ErrorActionPreference = 'Stop'
$tools = Join-Path $env:USERPROFILE '.pae\tools'
$venv = Join-Path $tools 'venv'
$bin = Join-Path $tools 'bin'
$python = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend\.venv\Scripts\python.exe'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    & $python -m venv $venv
    if ($LASTEXITCODE) { throw "could not create $venv" }
}
& (Join-Path $venv 'Scripts\python.exe') -m pip install --quiet --disable-pip-version-check --upgrade pip-audit bandit
if ($LASTEXITCODE) { throw 'pip install failed' }
New-Item -ItemType Directory -Force $bin | Out-Null
foreach ($name in 'pip-audit', 'bandit') {
    # The launcher knows the absolute path of its environment's python, so it runs from any folder.
    Copy-Item -Force (Join-Path $venv "Scripts\$name.exe") (Join-Path $bin "$name.exe")
    & (Join-Path $bin "$name.exe") --version
}

# gitleaks (finds secrets in code and git history): the official Windows release from GitHub, used only if it
# matches the SHA-256 checksum published with that release.
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/gitleaks/gitleaks/releases/latest' `
    -Headers @{ 'User-Agent' = 'install-security-tools' }
$version = $release.tag_name.TrimStart('v')
$zipName = "gitleaks_${version}_windows_x64.zip"
$zipAsset = $release.assets | Where-Object { $_.name -eq $zipName }
$sumAsset = $release.assets | Where-Object { $_.name -eq "gitleaks_${version}_checksums.txt" }
if (-not $zipAsset -or -not $sumAsset) { throw "gitleaks ${version}: no Windows archive or checksums in the release" }
$work = Join-Path ([IO.Path]::GetTempPath()) ('gitleaks-' + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
    $zip = Join-Path $work $zipName
    $sums = Join-Path $work 'checksums.txt'
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zip -UseBasicParsing
    Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $sums -UseBasicParsing
    $line = Get-Content $sums | Where-Object { $_ -match ('\s' + [regex]::Escape($zipName) + '$') } | Select-Object -First 1
    $expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { throw "gitleaks ${version}: checksum mismatch, not installed" }
    "gitleaks ${version}: $([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB, SHA-256 checked"
    Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'files')
    Copy-Item -Force (Join-Path $work 'files\gitleaks.exe') (Join-Path $bin 'gitleaks.exe')
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
& (Join-Path $bin 'gitleaks.exe') version

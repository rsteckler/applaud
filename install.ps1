# applaud installer for Windows
#
# Usage:
#   irm https://raw.githubusercontent.com/rsteckler/applaud/main/install.ps1 | iex
#
# What it does:
#   1. Ensures git is available.
#   2. Installs pnpm (via the official installer) if not already present.
#   3. Ensures Node.js >= 20 is available (installs via pnpm if missing).
#   4. Clones the applaud repo into .\applaud (or $env:APPLAUD_DIR).
#   5. Runs `pnpm install` and `pnpm build`.
#   6. Prints the commands to start applaud.

$ErrorActionPreference = 'Stop'

$RepoUrl    = if ($env:APPLAUD_REPO) { $env:APPLAUD_REPO } else { 'https://github.com/rsteckler/applaud.git' }
$RepoRef    = if ($env:APPLAUD_REF)  { $env:APPLAUD_REF }  else { 'v0.5.8' }
$InstallDir = if ($env:APPLAUD_DIR)  { $env:APPLAUD_DIR }  else { Join-Path $PWD 'applaud' }
$MinNodeMajor = 20

function Say($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

function Have($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Ensure-Git {
    if (-not (Have 'git')) {
        Fail 'git is required but not installed. Install Git from https://git-scm.com/download/win and re-run.'
    }
}

function Ensure-Pnpm {
    if (-not (Have 'pnpm')) {
        Say 'installing pnpm via get.pnpm.io'
        Invoke-WebRequest 'https://get.pnpm.io/install.ps1' -UseBasicParsing | Invoke-Expression
    }
    # Ensure PNPM_HOME is on PATH for this process, whether pnpm was just
    # installed or was installed in a previous run.
    if (-not $env:PNPM_HOME) {
        $env:PNPM_HOME = Join-Path $env:LOCALAPPDATA 'pnpm'
    }
    if ($env:PATH -notlike "*$($env:PNPM_HOME)*") {
        $env:PATH = "$($env:PNPM_HOME);$env:PATH"
    }
    if (-not (Have 'pnpm')) {
        Fail 'pnpm installation finished but the binary is not on PATH. Open a new terminal and re-run.'
    }
    $version = & pnpm --version
    Say "pnpm $version ready"
}

function Ensure-Node {
    if (Have 'node') {
        $nodeMajor = & node -p "process.versions.node.split('.')[0]"
        if ([int]$nodeMajor -ge $MinNodeMajor) {
            $nodeVersion = & node --version
            Say "node $nodeVersion detected"
            Ensure-NodeGyp
            return
        }
        $nodeVersion = & node --version
        Warn "node $nodeVersion is too old (need >= $MinNodeMajor)"
    }
    Say 'installing Node LTS via pnpm'
    & pnpm env use --global lts
    if (-not (Have 'node')) {
        # pnpm's env manager writes to the same PNPM_HOME dir.
        if ($env:PATH -notlike "*$($env:PNPM_HOME)*") {
            $env:PATH = "$($env:PNPM_HOME);$env:PATH"
        }
    }
    if (-not (Have 'node')) {
        Fail 'node is still not on PATH after pnpm env install. Open a new terminal and re-run.'
    }
    $nodeVersion = & node --version
    Say "node $nodeVersion installed"
    Ensure-NodeGyp
}

function Ensure-NodeGyp {
    # node-gyp is needed to compile native modules (e.g. better-sqlite3)
    # when no prebuilt binary is available for this Node version.
    if (-not (Have 'node-gyp')) {
        Say 'installing node-gyp'
        & pnpm add -g node-gyp
    }
}

function Clone-Repo {
    if (Test-Path $InstallDir) {
        $items = Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue
        if ($items) {
            if (Test-Path (Join-Path $InstallDir '.git')) {
                Say "updating existing checkout at $InstallDir"
                & git -C $InstallDir pull --ff-only
                if ($LASTEXITCODE -ne 0) { Fail "git pull failed in $InstallDir" }
                return
            }
            Fail "$InstallDir exists and is not empty. Set `$env:APPLAUD_DIR to a different path, or remove it."
        }
    }
    Say "cloning $RepoUrl (ref: $RepoRef) into $InstallDir"
    & git clone --depth 1 --branch $RepoRef $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
}

function Install-AndBuild {
    Say 'installing dependencies (pnpm install)'
    Push-Location $InstallDir
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed.' }
        Say 'building (pnpm build)'
        & pnpm build
        if ($LASTEXITCODE -ne 0) { Fail 'pnpm build failed.' }
    } finally {
        Pop-Location
    }
}

function Print-NextSteps {
    Write-Host ''
    Write-Host "applaud installed at $InstallDir" -ForegroundColor Green
    Write-Host ''
    Write-Host 'To start:'
    Write-Host "    cd $InstallDir"
    Write-Host '    pnpm start'
    Write-Host ''
    Write-Host 'Your browser will open to the setup wizard. You can also navigate to'
    Write-Host 'http://127.0.0.1:44471/setup manually if it does not open automatically.'
    Write-Host ''
}

# --- main ---
Say 'installing applaud (os: windows)'
Ensure-Git
Ensure-Pnpm
Ensure-Node
Clone-Repo
Install-AndBuild
Print-NextSteps

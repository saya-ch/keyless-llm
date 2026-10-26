#requires -Version 5.1
<#
  keyless-llm 启动器 —— 启动网关并在浏览器打开 Web 控制台
  ────────────────────────────────────────────────────────
  终端面板已下线：状态、探测、测速、出口扫描全部在 Web 控制台完成。

  用法:
    .\launch.ps1                # 默认端口 8788，自动打开浏览器
    .\launch.ps1 -Port 8799     # 换端口
    .\launch.ps1 -NoOpen        # 不自动开浏览器
    .\launch.ps1 -NoTakeOver    # 端口被占时不接管旧实例

  关闭此窗口（或 Ctrl+C）即停止网关。
#>
param(
  [int]$Port = 8788,
  [string]$HostAddress = "127.0.0.1",
  [string]$ServerKey = "sk-keyless-local",
  [switch]$NoTakeOver,
  [switch]$NoOpen,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$ApiDir  = $PSScriptRoot
$Entry   = Join-Path $ApiDir "server.mjs"
$LogDir  = Join-Path $ApiDir "logs"
$LogFile = Join-Path $LogDir "launcher.log"
$errFile = Join-Path $LogDir "launcher.err.log"

function Fail([string]$msg, [string]$detail) {
  Write-Host ""
  Write-Host "  x $msg" -ForegroundColor Red
  if ($detail) { Write-Host "    $detail" -ForegroundColor DarkGray }
  if (-not $NoPause) { try { if (-not [Console]::IsOutputRedirected) { Read-Host "  按回车退出" | Out-Null } } catch { } }
  exit 1
}

Write-Host ""
Write-Host "  keyless-llm 免鉴权网关" -ForegroundColor Cyan
Write-Host ("  " + ("-" * 46)) -ForegroundColor DarkGray

# ── 1. node ──────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "找不到 node" "请先安装 Node.js 22+ 并确保在 PATH 中" }
$node = $nodeCmd.Source

# ── 2. 端口接管 ─────────────────────────────────────────────────
function Get-ListenerPid([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { return ($c | Select-Object -First 1).OwningProcess }
  return $null
}
$existing = Get-ListenerPid $Port
if ($existing) {
  $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$existing" -ErrorAction SilentlyContinue
  $cmdline = if ($procInfo) { [string]$procInfo.CommandLine } else { "" }
  if ($cmdline -notmatch "server\.mjs") {
    Fail "端口 $Port 被其它程序占用 (PID $existing)" ("命令行: " + $cmdline)
  }
  if ($NoTakeOver) { Fail "端口 $Port 已有网关实例 (PID $existing)" "去掉 -NoTakeOver 可接管" }
  Write-Host ("  接管：停止旧实例 PID " + $existing + " ...") -ForegroundColor Yellow
  Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 250; if (-not (Get-ListenerPid $Port)) { break } }
  if (Get-ListenerPid $Port) { Fail "旧实例未释放端口 $Port" "请手动检查进程 $existing" }
}

# ── 3. 清理重复环境变量键 ────────────────────────────────────────
# 从 bash / IDE 继承的会话里可能同时存在 https_proxy 与 HTTPS_PROXY、
# Path 与 PATH/path 这类仅大小写不同的键，会让 Start-Process 抛
# "Item has already been added"。启动前删掉重复变体（保留第一个）。
function Remove-DuplicateEnvKeys {
  $seen = @{}
  $dups = @()
  foreach ($entry in [System.Environment]::GetEnvironmentVariables("Process").GetEnumerator()) {
    $lk = ([string]$entry.Key).ToLowerInvariant()
    if ($seen.ContainsKey($lk)) { $dups += [string]$entry.Key }
    else { $seen[$lk] = $true }
  }
  foreach ($k in $dups) {
    try { [System.Environment]::SetEnvironmentVariable($k, $null, "Process") } catch { }
  }
  return $dups
}
$removedEnv = Remove-DuplicateEnvKeys

# ── 4. 启动网关（附着本控制台，关窗即停）────────────────────────
$env:KEYLESS_KEY = $ServerKey
$env:PORT = "$Port"
$env:HOST = $HostAddress
# 父进程看门狗：网关每几秒检查本 PowerShell 是否还活着，
# 宿主退出（关窗/Ctrl+C/被杀）就自杀 —— 兜底所有退出路径
$env:KEYLESS_PARENT_PID = "$PID"

if ($removedEnv.Count -gt 0) {
  Write-Host ("  清理重复环境变量键: " + ($removedEnv -join ", ")) -ForegroundColor DarkGray
}
Write-Host ("  端口 :$Port · 日志 logs\launcher.log") -ForegroundColor DarkGray

$proxy = Start-Process $node -ArgumentList @("`"$Entry`"") `
  -WorkingDirectory $ApiDir -NoNewWindow -PassThru `
  -RedirectStandardOutput $LogFile -RedirectStandardError $errFile

# 等就绪（最多 30 秒）
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 250
  if ($proxy.HasExited) { break }
  try { $null = Invoke-RestMethod "http://${HostAddress}:${Port}/health" -TimeoutSec 1; $ready = $true; break } catch { }
}
if (-not $ready) {
  if (-not $proxy.HasExited) { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue }
  Write-Host ""
  Write-Host "  x 网关启动失败，日志末尾：" -ForegroundColor Red
  Get-Content $LogFile -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
  Get-Content $errFile -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkRed }
  if (-not $NoPause) { try { if (-not [Console]::IsOutputRedirected) { Read-Host "`n  按回车退出" | Out-Null } } catch { } }
  exit 1
}

# ── 5. 打开 Web 控制台 ──────────────────────────────────────────
$url = "http://${HostAddress}:${Port}/"
if (-not $NoOpen) { Start-Process $url }

Write-Host ""
Write-Host "  网关运行中  $url" -ForegroundColor Green
Write-Host "  Web 控制台已在浏览器打开（来源 / 模型 / 出口 / 统计）" -ForegroundColor DarkGray
Write-Host "  关闭此窗口或 Ctrl+C 即停止网关" -ForegroundColor Yellow
Write-Host ""

# ── 6. 守候：任何退出路径都确保网关随之停止 ─────────────────────
try {
  Wait-Process -Id $proxy.Id -ErrorAction SilentlyContinue
} finally {
  try {
    if ($proxy -and -not $proxy.HasExited) { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue }
  } catch { }
}

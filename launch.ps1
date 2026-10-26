<#
  Free LLM Gateway — 免鉴权免费大模型聚合网关 / 启动器面板
  ─────────────────────────────────────────────────────────
  窗口开着 = 网关在跑；关掉窗口 = 立即停止。

  不自动刷新：屏幕只在启动时画一次，之后只有你按键才重绘。
  按键：R 轻探测（每模型 1 token，只判可用性）
        T 测速（真生成内容，消耗较多 token）
        E 出口扫描   Q 退出（同时停网关）

  面板数据全部实时抓取：
    · 来源汇总        ← 各 provider 的模型数 / 可用 / 限流 / 封禁
    · 可用模型        ← 代理 /v1/status（只列能调度的）
    · 实测 TPS        ← measure-speed.mjs（经本地网关真流式计时）

  模型命名：<来源>/<模型>，例 kilo/reflection/beam-free；也可只写模型名自动匹配。
  调用失败会在同来源内换模型，再跨来源转移。

  用法：
    launch.ps1                默认 8788
    launch.ps1 -Port 8799     换端口
    launch.ps1 -AutoSpeed     启动时顺便测速（默认不测，省 token）
    launch.ps1 -ShowKey       显示完整本地 API Key
    launch.ps1 -NoTakeOver    端口被占时不接管
    launch.ps1 -NoColor       纯文本（重定向/日志友好）
    launch.ps1 -MaxFrames 1   只画 N 帧后退出（调试）
#>
param(
  [int]$Port = 8788,
  [string]$HostAddress = "127.0.0.1",
  [switch]$ShowKey,
  [switch]$NoTakeOver,
  [switch]$NoPause,
  [switch]$NoColor,
  [switch]$NoSpeedTest,
  [switch]$AutoSpeed,
  [string]$LogPanel,
  [int]$MaxFrames = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ApiDir = $PSScriptRoot
$Entry  = Join-Path $ApiDir "server.mjs"
$LogDir = Join-Path $ApiDir "logs"
$LogFile = Join-Path $LogDir "launcher.log"
$ServerKey = if ($env:KEYLESS_KEY) { $env:KEYLESS_KEY } elseif ($env:OC2FREE_KEY) { $env:OC2FREE_KEY } else { "sk-keyless-local" }

# ══ 颜色 ══════════════════════════════════════════════════════
$ESC = [char]27
$script:UseColor = -not $NoColor
try { if ([Console]::IsOutputRedirected) { $script:UseColor = $false } } catch { $script:UseColor = $false }

$script:ANSI = @{
  Cyan = "$ESC[36m"; DarkCyan = "$ESC[2;36m"; White = "$ESC[97m"; Gray = "$ESC[37m"
  DarkGray = "$ESC[90m"; Green = "$ESC[92m"; DarkYellow = "$ESC[33m"; Yellow = "$ESC[93m"
  Red = "$ESC[91m"; DarkRed = "$ESC[2;31m"; Reset = "$ESC[0m"
}

# ══ 宽度计算（中文占 2 列）════════════════════════════════════
function Get-DisplayWidth([string]$s) {
  if (-not $s) { return 0 }
  $w = 0
  foreach ($ch in $s.ToCharArray()) {
    $c = [int][char]$ch
    if ($c -ge 0x1100 -and (
        ($c -le 0x115F) -or ($c -ge 0x2E80 -and $c -le 0x303E) -or
        ($c -ge 0x3041 -and $c -le 0x33FF) -or ($c -ge 0x3400 -and $c -le 0x4DBF) -or
        ($c -ge 0x4E00 -and $c -le 0x9FFF) -or ($c -ge 0xA000 -and $c -le 0xA4CF) -or
        ($c -ge 0xAC00 -and $c -le 0xD7A3) -or ($c -ge 0xF900 -and $c -le 0xFAFF) -or
        ($c -ge 0xFE30 -and $c -le 0xFE6F) -or ($c -ge 0xFF00 -and $c -le 0xFF60) -or
        ($c -ge 0xFFE0 -and $c -le 0xFFE6))) { $w += 2 } else { $w += 1 }
  }
  return $w
}
function PadR([string]$s, [int]$width) {
  $pad = $width - (Get-DisplayWidth $s); if ($pad -lt 0) { $pad = 0 }
  return $s + (" " * $pad)
}
function PadL([string]$s, [int]$width) {
  $pad = $width - (Get-DisplayWidth $s); if ($pad -lt 0) { $pad = 0 }
  return (" " * $pad) + $s
}
function Clip([string]$s, [int]$width) {
  if ((Get-DisplayWidth $s) -le $width) { return $s }
  $out = ""; $w = 0
  foreach ($ch in $s.ToCharArray()) {
    $cw = Get-DisplayWidth ([string]$ch)
    if ($w + $cw -gt $width - 1) { break }
    $out += $ch; $w += $cw
  }
  return $out + "…"
}

function Fail($msg, $hint) {
  Write-Host ""
  Write-Host ("  x " + $msg) -ForegroundColor Red
  if ($hint) { Write-Host ("    " + $hint) -ForegroundColor DarkGray }
  Write-Host ""
  if (-not $NoPause) { Read-Host "  按回车退出" | Out-Null }
  exit 1
}

# ── 0. 前置检查 ───────────────────────────────────────────────────
if (-not (Test-Path $Entry)) { Fail "找不到代理入口: $Entry" "请确认 server.mjs 与本脚本同目录" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ── 1. 端口占用 ───────────────────────────────────────────────────
function Get-ListenerPid([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { return ($c | Select-Object -First 1).OwningProcess }
  return $null
}
$existing = Get-ListenerPid $Port
if ($existing) {
  $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$existing" -ErrorAction SilentlyContinue
  # 凭 PID 文件认亲：只有本代理写的 proxy.pid 命中才接管，绝不误杀别的程序
  $pidFile = Join-Path $LogDir "proxy.pid"
  $isOurs = $false
  if (Test-Path $pidFile) {
    try { $isOurs = ([int](Get-Content $pidFile -Raw).Trim()) -eq $existing } catch { }
  }
  if (-not $isOurs) {
    Fail "端口 $Port 被其它程序占用 (PID $existing)" ("命令行: " + $procInfo.CommandLine)
  }
  if ($NoTakeOver) { Fail "端口 $Port 已有代理实例 (PID $existing)" "去掉 -NoTakeOver 可接管" }
  Write-Host ("  接管：停止旧实例 PID " + $existing + " ...") -ForegroundColor Yellow
  Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 250; if (-not (Get-ListenerPid $Port)) { break } }
  if (Get-ListenerPid $Port) { Fail "旧实例未释放端口 $Port" "请手动检查进程 $existing" }
}

# ── 2. 拉起代理（附着控制台 → 关窗口即停）────────────────────────
$env:KEYLESS_KEY = $ServerKey
$env:PORT = "$Port"
$env:HOST = $HostAddress

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "找不到 node" "请先安装 Node.js 22+ 并确保在 PATH 中" }

$errFile = Join-Path $LogDir "launcher.err.log"
$node = $nodeCmd.Source
$proxy = $null
$foreground = $false

# ── 清理重复的环境变量键 ──────────────────────────────────────
# 从 bash / IDE 继承的会话里可能同时存在 https_proxy 与 HTTPS_PROXY、
# Path 与 PATH/path 这类仅大小写不同的键。PowerShell 5.1 的 Start-Process
# 在构造子进程环境字典时会因此抛 "Item has already been added"，导致
# 后台启动失败并降级到前台模式 —— 而前台模式下没有面板。
# 这里在启动前把仅小写变体从当前进程环境里删掉（保留规范的大写名）。
function Remove-DuplicateEnvKeys {
  $seen = @{}
  $dups = @()
  foreach ($entry in [System.Environment]::GetEnvironmentVariables("Process").GetEnumerator()) {
    $k = [string]$entry.Key
    $lk = $k.ToLowerInvariant()
    if ($seen.ContainsKey($lk)) {
      # 已存在同名（小写）键：保留字典里第一个，其余视为重复
      $dups += $k
    } else {
      $seen[$lk] = $k
    }
  }
  foreach ($k in $dups) {
    try { [System.Environment]::SetEnvironmentVariable($k, $null, "Process") } catch { }
  }
  return $dups
}
$removedEnv = Remove-DuplicateEnvKeys
if ($removedEnv.Count -gt 0) {
  Write-Host ("  清理重复环境变量键: " + ($removedEnv -join ", ")) -ForegroundColor DarkGray
}

try {
  # 首选：后台子进程 + 输出重定向到日志（与 ccgo2dsapi 同款）
  # 注：某些从 bash 继承的会话环境里存在 Path/PATH/path 大小写重复键，
  # 会导致 Start-Process 抛 "Key in dictionary" —— 已在上方清理，此处保留兜底
  $proxy = Start-Process $node -ArgumentList @("`"$Entry`"") `
    -WorkingDirectory $ApiDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $LogFile -RedirectStandardError $errFile
} catch {
  Write-Host ""
  Write-Host "  ! 后台启动失败（$($_.Exception.Message.Split([char]10)[0])）" -ForegroundColor DarkYellow
  Write-Host "    转为前台运行模式：代理日志直接输出，Ctrl+C 或关窗停止" -ForegroundColor DarkGray
  $foreground = $true
}

$ready = $false
if (-not $foreground) {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if ($proxy.HasExited) { break }
    try { $null = Invoke-RestMethod "http://${HostAddress}:${Port}/health" -TimeoutSec 1; $ready = $true; break } catch { }
  }
  if (-not $ready) {
    if (-not $proxy.HasExited) { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue }
    Write-Host ""
    Write-Host "  x 代理启动失败，日志末尾：" -ForegroundColor Red
    Get-Content $LogFile -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
    Get-Content $errFile -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkRed }
    if (-not $NoPause) { Read-Host "`n  按回车退出" | Out-Null }
    exit 1
  }
}

# ── 3. 数据层（全部来自本地代理 /v1/status）──────────────────────
$script:status = $null
$script:speed = @{}
$script:speedAt = $null
$script:speedSummary = $null
$script:speedSummaryColor = "DarkGray"
$script:egress = $null
$script:statusAt = $null
$script:ver = "?"

function Update-Status {
  try {
    $resp = Invoke-WebRequest "http://${HostAddress}:${Port}/v1/status" -UseBasicParsing -TimeoutSec 10
    $json = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
    $script:status = $json | ConvertFrom-Json
    $script:ver = $script:status.version
    $script:statusAt = Get-Date
  } catch { $script:status = $null }
}

function Update-Speed {
  if ($NoSpeedTest) { return }
  # 本轮结果覆盖上一轮，避免新旧混显
  $script:speed = @{}
  $script:speedSummary = $null
  # 选取测速目标：优先可用/未探测的；若全部限流或封禁，仍要测——
  # 否则连失败原因都拿不到，面板就只能显示 "-"。
  $pool = @()
  if ($script:status -and $script:status.models) {
    $pool = @($script:status.models |
      Where-Object { $_.state -eq "healthy" -or $_.state -eq "unknown" } |
      Select-Object -First 3 -ExpandProperty id)
    if ($pool.Count -eq 0) {
      $ordered = @($script:status.models | Where-Object { $_.state -ne "blocked" })
      if ($ordered.Count -eq 0) { $ordered = @($script:status.models) }
      $pool = @($ordered | Sort-Object cooldownUntil | Select-Object -First 3 -ExpandProperty id)
    }
  }
  if ($pool.Count -eq 0) { return }
  $sp = Join-Path $ApiDir "measure-speed.mjs"
  if (-not (Test-Path $sp)) { return }

  $raw = $null
  try { $raw = & node $sp --port $Port --key $ServerKey --models ($pool -join ",") 2>$null } catch { }
  if (-not $raw) {
    # 脚本本身没跑起来：也要留痕，不能静默
    foreach ($m in $pool) {
      $script:speed[$m] = [pscustomobject]@{ kind = "error"; code = "ERR"; detail = "测速脚本无输出" }
    }
    $script:speedSummary = "0/$($pool.Count) 成功 · 测速脚本无输出"
    $script:speedSummaryColor = "Red"
    $script:speedAt = Get-Date
    return
  }

  $obj = $null
  try { $obj = (($raw | Out-String).Trim()) | ConvertFrom-Json } catch { }
  if ($null -eq $obj) {
    foreach ($m in $pool) {
      $script:speed[$m] = [pscustomobject]@{ kind = "error"; code = "ERR"; detail = "测速结果无法解析" }
    }
    $script:speedSummary = "0/$($pool.Count) 成功 · 结果无法解析"
    $script:speedSummaryColor = "Red"
    $script:speedAt = Get-Date
    return
  }

  $okCount = 0
  $firstErr = $null
  foreach ($m in $pool) {
    $v = $obj.$m
    if ($null -eq $v) {
      $script:speed[$m] = [pscustomobject]@{ kind = "error"; code = "ERR"; detail = "无返回" }
      if (-not $firstErr) { $firstErr = "无返回" }
      continue
    }
    if ($v.ok -eq $true -and $null -ne $v.tps) {
      $script:speed[$m] = [pscustomobject]@{ kind = "ok"; tps = [double]$v.tps; ttft = $v.ttft; total = $v.total; tokens = $v.tokens }
      $okCount++
    } else {
      # 失败也是结果：状态码 + 原因（429/403/超时/网络），保留给面板显示
      $code = if ($v.status) { "$($v.status)" } elseif ($v.error) { ([string]$v.error).ToUpper() } else { "ERR" }
      if ($code.Length -gt 5) { $code = $code.Substring(0, 5) }
      $detail = [string]$v.error
      if ($v.detail) { $detail = "$($v.error): $($v.detail)" }
      $script:speed[$m] = [pscustomobject]@{ kind = "error"; code = $code; detail = $detail }
      if (-not $firstErr) { $firstErr = "$code $([string]$v.error)" }
    }
  }

  $script:speedAt = Get-Date
  if ($okCount -eq $pool.Count) {
    $script:speedSummary = "$okCount/$($pool.Count) 成功"
    $script:speedSummaryColor = "Green"
  } elseif ($okCount -eq 0) {
    $script:speedSummary = "0/$($pool.Count) 全部失败 · $firstErr"
    $script:speedSummaryColor = "Red"
  } else {
    $script:speedSummary = "$okCount/$($pool.Count) 成功 · 其余失败（$firstErr）"
    $script:speedSummaryColor = "Yellow"
  }
  # 落一行到日志，方便事后排查
  try { Add-Content -Path $LogFile -Value ("[{0}] speed: {1}" -f (Get-Date).ToString("HH:mm:ss"), $script:speedSummary) -Encoding UTF8 } catch { }
}

function Update-Egress {
  # PS 5.1 的 Invoke-RestMethod 会按 Latin-1 解 UTF-8，中文/emoji 会变乱码，故手工解码
  try {
    $resp = Invoke-WebRequest "http://${HostAddress}:${Port}/v1/egress" -UseBasicParsing -TimeoutSec 10
    $json = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
    $script:egress = $json | ConvertFrom-Json
  } catch { $script:egress = $null }
}

# 出口名太长且带 emoji，面板用短名（emoji 宽度算不准会错列）
function ShortNodeName([string]$s) {
  if (-not $s) { return "-" }
  if ($s -eq "DIRECT") { return "本机直连" }
  $t = [regex]::Replace($s, '[\uD800-\uDFFF]', '')     # 去 emoji 代理对
  $t = [regex]::Replace($t, '[^\x20-\x7e\u4e00-\u9fff\-\._]', '')  # 只留 ASCII/CJK/基本符号
  $t = ($t -split '\|')[0].Trim()
  if (-not $t) { $t = $s }
  return $t
}

function Get-StateText($st) {
  switch ($st) {
    "healthy" { return "可用" }
    "limited" { return "429限流" }
    "blocked" { return "403封禁" }
    "unknown" { return "待验证" }
    default   { return "待验证" }
  }
}
function Get-StateColor($st) {
  switch ($st) {
    "healthy" { return "Green" }
    "limited" { return "Yellow" }
    "blocked" { return "Red" }
    default   { return "DarkGray" }
  }
}
function FmtCdUntil($untilMs) {
  if (-not $untilMs) { return "-" }
  $remain = [int](([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$untilMs)) - (Get-Date).ToUniversalTime()).TotalSeconds
  if ($remain -le 0) { return "-" }
  if ($remain -ge 3600) { return ("{0:h\:mm}" -f [TimeSpan]::FromSeconds($remain)) }
  return ("{0:m\:ss}" -f [TimeSpan]::FromSeconds($remain))
}
function FmtCtx($ctx) {
  if (-not $ctx) { return "-" }
  if ($ctx -ge 1000000) { return ("{0:0.##}M" -f ($ctx / 1e6)) }
  return ("{0:0}K" -f ($ctx / 1e3))
}

# ── 4. 渲染 ───────────────────────────────────────────────────────
$INNER = 74

function Render {
  $L = [System.Collections.Generic.List[object]]::new()
  $script:__L = $L
  function AddRow([string]$c, [string]$col) {
    $script:__L.Add([pscustomobject]@{ t = ("  |" + (PadR ("  " + $c) $INNER) + "|"); c = $col })
  }
  function AddSep { $script:__L.Add([pscustomobject]@{ t = ("  +" + ("-" * $INNER) + "+"); c = "Cyan" }) }
  function AddDiv { $script:__L.Add([pscustomobject]@{ t = ("  |  " + ("-" * ($INNER - 4)) + "  |"); c = "DarkGray" }) }

  AddSep
  $titleL = "  Free LLM Gateway"
  $titleR = "v$($script:ver) :$Port"
  $gap = $INNER - (Get-DisplayWidth $titleL) - (Get-DisplayWidth $titleR); if ($gap -lt 1) { $gap = 1 }
  $L.Add([pscustomobject]@{ t = ("  |" + $titleL + (" " * $gap) + $titleR + "|"); c = "Cyan" })
  AddSep

  AddRow "接入信息" "Cyan"
  AddRow "OpenAI 兼容     http://${HostAddress}:${Port}/v1" "White"
  AddRow "Anthropic 兼容  http://${HostAddress}:${Port}" "White"
  AddRow "API Key         $ServerKey" "White"
  AddSep

  # ── 来源汇总 ──
  $okN = 0
  $all = @()
  if ($script:status -and $script:status.providers) {
    $all = @($script:status.models)
    $okN = @($all | Where-Object { $_.state -eq "healthy" }).Count
    $autoN = @($all | Where-Object { $_.auto }).Count
    AddRow ("来源     $($script:status.providers.Count) 个 · 模型 $($all.Count) · 可调度 $okN · auto 池 $autoN") "Cyan"
    AddRow ((PadR "  id" 19) + (PadR "名称" 15) + (PadL "模型" 4) + (PadL "可用" 4) + (PadL "auto" 5) + "  " + (PadR "限流说明" 20)) "DarkGray"
    AddDiv
    foreach ($p in @($script:status.providers)) {
      $s = $p.summary
      $mine = @($all | Where-Object { $_.provider -eq $p.id })
      $autoC = @($mine | Where-Object { $_.auto }).Count
      $label = [string]$p.label
      if (-not $p.enabled) { $label += "（停用）" }
      $col = if (-not $p.enabled) { "DarkGray" } elseif ($s.healthy -gt 0) { "Green" } elseif ($s.total -gt 0) { "Yellow" } else { "DarkGray" }
      AddRow ((PadR ("  " + $p.id) 19) + (PadR (Clip $label 15) 15) + (PadL ([string]$s.total) 4) + (PadL ([string]$s.healthy) 4) + (PadL ([string]$autoC) 5) + "  " + (PadR (Clip ([string]$p.rate) 20) 20)) $col
    }
  } else {
    AddRow "来源     （状态获取失败，按 R 重试）" "DarkRed"
  }

  # ── 模型 · 按来源分组 ──
  # 只列 healthy 会误伤刚启动的场景：首次探测要 ~2 分钟，期间全是 unknown，
  # 面板就会显示「暂无可调度」，看起来像没有模型。这里列出全部模型并标注状态，
  # 让「哪些能用 / 哪些在冷却 / 哪些还没验」一目了然。
  AddSep
  if ($all.Count -gt 0) {
    AddRow ("模型     共 $($all.Count) 个   auto = 准入 auto 池（ctx≥256K 且支持工具调用）") "Cyan"
    AddRow ((PadR "  模型" 44) + (PadL "上下文" 7) + (PadL "auto" 5) + (PadL "状态" 11) + (PadL "TPS" 8)) "DarkGray"
    AddDiv
    foreach ($p in @($script:status.providers | Where-Object { $_.enabled })) {
      $mine = @($all | Where-Object { $_.provider -eq $p.id })
      if ($mine.Count -eq 0) { continue }
      $h = @($mine | Where-Object { $_.state -eq "healthy" })
      AddRow ("▸ " + (PadR (Clip "$($p.id) · $($p.label)" 44) 44) + (PadL "$($h.Count)/$($mine.Count)" 12) + (PadL "可调度" 9)) "Cyan"
      # 可用优先，其次待验证，最后限流/封禁
      $sorted = $mine | Sort-Object @{ e = { switch ($_.state) { "healthy" { 0 } "unknown" { 1 } "limited" { 2 } default { 3 } } } }, @{ e = { if ($_.tps) { -[double]$_.tps } else { -999 } } }
      foreach ($m in ($sorted | Select-Object -First 10)) {
        $tps = "-"
        if ($script:speed.ContainsKey($m.id)) {
          $e = $script:speed[$m.id]
          if ($e.kind -eq "error") { $tps = [string]$e.code }
          else { $tps = ("{0:0}" -f $e.tps) + " t/s" }
        }
        $autoT = if ($m.auto) { "auto" } else { "" }
        $stText = Get-StateText $m.state
        if ($m.state -eq "limited" -and $m.cooldownUntil) { $stText = $stText + " " + (FmtCdUntil $m.cooldownUntil) }
        # 整行单色：可用=白，待验证=灰，限流=黄，封禁=红
        $rowCol = switch ($m.state) { "healthy" { "White" } "limited" { "Yellow" } "blocked" { "Red" } default { "DarkGray" } }
        AddRow ((PadR ("      " + (Clip ([string]$m.model) 38)) 44) + (PadL (FmtCtx $m.ctx) 7) + (PadL $autoT 5) + (PadL $stText 11) + (PadL $tps 8)) $rowCol
      }
      if ($mine.Count -gt 10) { AddRow ("      … 另有 $($mine.Count - 10) 个") "DarkGray" }
    }
  } else {
    AddRow "模型     （状态获取失败，按 R 重试）" "DarkRed"
  }
  AddRow "TPS 仅 T 键实测（真生成）；auto 调度失败自动换模型/跨来源" "DarkGray"
  if ($script:speedSummary) {
    AddRow ("测速结果  " + (Clip $script:speedSummary ($INNER - 14))) $script:speedSummaryColor
  }
  AddSep

  $s = $script:status
  if ($s -and $s.summary) {
    $sum = $s.summary
    AddRow "运行统计" "Cyan"
    AddDiv
    $tokTxt = "$($s.stats.tokensIn)/$($s.stats.tokensOut)"
    AddRow ((PadR "累计请求" 12) + (PadL ([string]$s.stats.requests) 8) + (PadR "  经代理转发的请求总数" 32)) "White"
    AddRow ((PadR "轮换转移" 12) + (PadL ([string]$s.stats.failovers) 8) + (PadR "  超限后自动切换次数（同来源/跨来源）" 32)) "White"
    AddRow ((PadR "token 入/出" 12) + (PadL $tokTxt 8) + (PadR "  上游回报的 usage 累计" 32)) "White"
    $lp = if ($s.lastProbeAt) { ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$s.lastProbeAt)).ToLocalTime().ToString("HH:mm:ss") } else { "-" }
    AddRow ((PadR "最近探测" 12) + (PadL $lp 8) + (PadR "  R 键轻探测（每模型 1 token）" 32)) "DarkGray"
  } else {
    AddRow "运行统计   （状态获取失败，按 R 重试）" "DarkRed"
  }
  AddSep

  # ── 出口探测（同一批模型 × 不同出口 IP）──
  $eg = $script:egress
  if ($eg -and $eg.results -and @($eg.results).Count -gt 0) {
    $egAt = if ($eg.scannedAt) { ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$eg.scannedAt)).ToLocalTime().ToString("HH:mm") } else { "-" }
    $egState = if ($eg.scanning) { " · 扫描中" } else { "" }
    AddRow ("出口探测   同一批模型换不同出口 IP   扫描于 $egAt$egState") "Cyan"
    AddRow ((PadR "出口" 20) + (PadR "地区" 5) + (PadL "可用" 6) + "  " + (PadR "出口 IP" 16)) "DarkGray"
    AddDiv
    $bestOk = 0
    foreach ($r in @($eg.results)) {
      $okN = [int]$r.ok
      if ($okN -gt $bestOk) { $bestOk = $okN }
      $rowCol = if ($okN -gt 0) { "Green" } else { "DarkGray" }
      $nameTxt = ShortNodeName ([string]$r.egress)
      AddRow ((PadR (Clip $nameTxt 20) 20) + (PadR ([string]$r.loc) 5) + (PadL ("$okN/" + [int]$r.total) 6) + "  " + (PadR ([string]$r.ip) 16)) $rowCol
    }
    if ($bestOk -eq 0) {
      AddRow "结论：所有出口均无可用模型（换 IP 无效，额度整体关闭）" "Yellow"
    } else {
      AddRow "结论：存在可用出口，代理会在可用模型间调度" "Green"
    }
  }

  $L.Add([pscustomobject]@{ t = ("  |" + (PadR ("  日志  " + (Clip $LogFile ($INNER - 10))) $INNER) + "|"); c = "DarkGray" })
  $L.Add([pscustomobject]@{ t = ("  |" + (PadR "  关闭此窗口 = 立即停止代理" $INNER) + "|"); c = "Green" })
  AddSep

  $stTxt = if ($script:statusAt) { $script:statusAt.ToString("HH:mm:ss") } else { "-" }
  $spTxt = if ($script:speedAt) { " · 测速 " + $script:speedAt.ToString("HH:mm") } else { "" }
  $status = "  更新于 " + $stTxt + " · R 探测  T 测速  E 出口  Q 退出" + $spTxt
  $L.Add([pscustomobject]@{ t = (PadR $status ($INNER + 4)); c = "DarkCyan" })

  return ,$L
}

# 逐行输出：只在启动和按键时调用，不做定时重绘，所以不会闪
function DrawPanel([string]$prefix) {
  if ($prefix) { Write-Host ""; Write-Host ("  " + $prefix) -ForegroundColor DarkGray }
  $plain = [System.Collections.Generic.List[string]]::new()
  if ($prefix) { $plain.Add("  " + $prefix) }
  foreach ($x in (Render)) {
    if ($script:UseColor -and $script:ANSI.ContainsKey($x.c)) {
      Write-Host ($script:ANSI[$x.c] + $x.t + $script:ANSI.Reset)
    } else { Write-Host $x.t }
    $plain.Add($x.t)
  }
  if ($LogPanel) {
    try {
      $plain.Add("")
      [System.IO.File]::AppendAllLines($LogPanel, $plain.ToArray(), [System.Text.Encoding]::UTF8)
    } catch { }
  }
  # 记录本次输出的行数，供自动刷新时原地重绘（清屏 + 上移）
  $script:LastFrameLines = $plain.Count
}

# 原地重绘：把光标移回面板顶部，清掉旧内容再画新的一帧
function RedrawPanel([string]$prefix) {
  if (-not $script:CanReadKeys) { return }
  try {
    $lines = [int]($script:LastFrameLines)
    if ($lines -gt 0) {
      # 先清整个屏幕（2J）+ 光标归位（H），再重绘 —— 避免旧帧残留在光标上方留下空行
      $seq = "$ESC[2J" + "$ESC[H"
      Write-Host $seq -NoNewline
    }
    DrawPanel $prefix
  } catch { }
}

# ── 5. 主循环：只响应按键，不自动刷新 ─────────────────────────────
Update-Status
Update-Egress
# 测速要真生成内容（每个模型几百 token），默认不自动跑；轻探测在代理侧自动完成
if ($AutoSpeed -and -not $NoSpeedTest -and -not $foreground) { Update-Speed }

if ($foreground) {
  # 前台模式：代理占用控制台，面板不可交互；关窗/Ctrl+C 即停
  Write-Host ""
  Write-Host "  [前台模式] 代理运行中，关闭窗口或 Ctrl+C 停止" -ForegroundColor DarkYellow
  try { & $node $Entry } finally { }
  if (-not $NoPause) { try { if (-not [Console]::IsOutputRedirected) { Read-Host "`n  按回车关闭窗口" | Out-Null } } catch { } }
  exit 0
}

DrawPanel ""
$frames = 1

# 启动即触发一次轻探测：否则首次探测要等代理侧的自然周期，
# 面板会长时间停留在「全部待验证」，用户以为没有模型。
try {
  $null = Invoke-RestMethod "http://${HostAddress}:${Port}/v1/probe?force=1" -Method POST -TimeoutSec 5
  Write-Host "  正在探测免费模型（每模型 1 token，约 10-60 秒）..." -ForegroundColor DarkGray
  Start-Sleep -Seconds 3
  Update-Status
  DrawPanel ("已探测 · " + (Get-Date).ToString("HH:mm:ss"))
} catch { }

# 判断能否接收按键：没有真实控制台时退化为「只守候代理进程」
$script:CanReadKeys = $true
try {
  $null = [Console]::KeyAvailable
} catch {
  $script:CanReadKeys = $false
}
if (-not $script:CanReadKeys) {
  Write-Host ""
  Write-Host "  [提示] 当前没有可交互的控制台，R/T/Q 按键不可用；代理会持续运行。" -ForegroundColor DarkYellow
  Write-Host "         关闭此窗口或结束进程即可停止代理。" -ForegroundColor DarkGray
}

try {
  while ($true) {
    if ($proxy.HasExited) { break }
    if ($MaxFrames -gt 0 -and $frames -ge $MaxFrames) { break }

    if (-not $script:CanReadKeys) {
      Wait-Process -Id $proxy.Id -ErrorAction SilentlyContinue
      break
    }

    $action = $null
    $lastAuto = Get-Date
    $lastSig = ""
    while ($null -eq $action) {
      if ($proxy.HasExited) { break }
      try {
        if ([Console]::KeyAvailable) {
          switch ([Console]::ReadKey($true).Key) {
            "R" { $action = "refresh" }
            "T" { $action = "speed" }
            "E" { $action = "egress" }
            "Q" { $action = "quit" }
            default { }
          }
        }
      } catch {
        $script:CanReadKeys = $false
        break
      }
      # 自动刷新：轻探测在代理侧每 30 分钟跑一次，面板跟着同步，
      # 否则用户看到的永远是启动那一刻的快照（当时多半还没探测，全是 unknown）。
      if (((Get-Date) - $lastAuto).TotalSeconds -ge 20) {
        $lastAuto = Get-Date
        Update-Status
        if ($script:status -and $script:status.models) {
          $sig = (@($script:status.models | Where-Object { $_.state -eq "healthy" }).Count).ToString() + "/" +
                 (@($script:status.models | Where-Object { $_.auto }).Count).ToString()
          if ($lastSig -and $sig -ne $lastSig) {
            RedrawPanel ("自动更新 · " + (Get-Date).ToString("HH:mm:ss"))
          }
          $lastSig = $sig
        }
      }
      if ($null -eq $action) { Start-Sleep -Milliseconds 150 }
    }
    if ($proxy.HasExited) { break }
    if ($action -eq "quit") { break }
    if (-not $script:CanReadKeys) { continue }

    if ($action -eq "refresh") {
      Write-Host ""
      Write-Host "  正在探测全部免费模型（约 10 秒）..." -ForegroundColor DarkGray
      try { $null = Invoke-RestMethod "http://${HostAddress}:${Port}/v1/probe?force=1" -Method POST -TimeoutSec 5 } catch { }
      Start-Sleep -Seconds 12
      Update-Status
      DrawPanel ("已刷新 · " + (Get-Date).ToString("HH:mm:ss"))
    }
    elseif ($action -eq "speed") {
      Write-Host ""
      Write-Host "  正在测速（约 10 秒）..." -ForegroundColor DarkGray
      Update-Speed
      DrawPanel ("已测速 · " + (Get-Date).ToString("HH:mm:ss"))
    }
    elseif ($action -eq "egress") {
      Write-Host ""
      Write-Host "  正在扫描出口（会短暂切换 Clash 节点，约 1-3 分钟）..." -ForegroundColor DarkYellow
      try { $null = Invoke-RestMethod "http://${HostAddress}:${Port}/v1/egress/scan?models=3" -Method POST -TimeoutSec 5 } catch { }
      for ($i = 0; $i -lt 100; $i++) {
        Start-Sleep -Seconds 2
        Update-Egress
        if (-not ($script:egress -and $script:egress.scanning)) { break }
      }
      DrawPanel ("已扫描出口 · " + (Get-Date).ToString("HH:mm:ss"))
    }
    $frames++
  }
} finally {
  if ($proxy -and -not $proxy.HasExited) {
    try { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

if ($MaxFrames -eq 0) {
  Write-Host ""
  if ($proxy.HasExited) {
    Write-Host "  代理进程已退出，日志末尾：" -ForegroundColor Yellow
    Get-Content $LogFile -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
  } else {
    Write-Host "  已退出，代理已停止。" -ForegroundColor Yellow
  }
}
if (-not $NoPause) {
  try { if (-not [Console]::IsOutputRedirected) { Read-Host "`n  按回车关闭窗口" | Out-Null } } catch { }
}

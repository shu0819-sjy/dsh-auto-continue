#Requires -Version 5.1
<#
.SYNOPSIS
  安装 auto-continue + anti-repetition 到本机 DSH 数据目录。
.PARAMETER DataDir
  可选。DSH 数据目录（含 profiles/web/）。未指定时按 DSH_HOME → 常见路径探测。
.EXAMPLE
  pwsh -File install/install.ps1
  pwsh -File install/install.ps1 -DataDir "$env:DSH_HOME"
#>
[CmdletBinding()]
param(
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginsSrc = Join-Path $RepoRoot "plugins"
$SnippetPath = Join-Path $RepoRoot "examples\cordis-patch.snippet.yml"

function Resolve-DataDir {
  param([string]$Override)
  if ($Override) {
    if (-not (Test-Path -LiteralPath $Override)) {
      throw "指定的 -DataDir 不存在：$Override"
    }
    return (Resolve-Path -LiteralPath $Override).Path
  }
  $candidates = @()
  if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA "dsh-desktop\data") }

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      return (Resolve-Path -LiteralPath $c).Path
    }
  }
  throw @"
未能定位 DSH 数据目录。请用 -DataDir 手动指定，例如：
  pwsh -File install/install.ps1 -DataDir `$env:DSH_HOME
探测顺序：环境变量 DSH_HOME → `$env:APPDATA\dsh-desktop\data
"@
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Get-FileSha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# --- main ---
$data = Resolve-DataDir -Override $DataDir
$webDir = Join-Path $data "profiles\web"
$pluginsDst = Join-Path $webDir "plugins"
$patchPath = Join-Path $webDir "cordis.patch.yml"

Write-Host "数据目录: $data"
Write-Host "仓库根:   $RepoRoot"

if (-not (Test-Path -LiteralPath $PluginsSrc)) {
  throw "找不到仓库 plugins/：$PluginsSrc"
}
if (-not (Test-Path -LiteralPath $SnippetPath)) {
  throw "找不到 examples/cordis-patch.snippet.yml：$SnippetPath"
}

# 1) 确保插件目录
New-Item -ItemType Directory -Force -Path $pluginsDst | Out-Null

# 2) 复制插件
$copied = @()
Get-ChildItem -LiteralPath $PluginsSrc -Filter "*.mjs" | ForEach-Object {
  $dst = Join-Path $pluginsDst $_.Name
  Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
  $srcHash = Get-FileSha256 $_.FullName
  $dstHash = Get-FileSha256 $dst
  if ($srcHash -ne $dstHash) {
    throw "复制校验失败：$($_.Name) SHA256 不一致"
  }
  $copied += $_.Name
  Write-Host ("已复制 plugins/{0}  (SHA256={1})" -f $_.Name, $srcHash)
}
if ($copied.Count -eq 0) {
  throw "仓库 plugins/ 下没有 .mjs 文件"
}

# 3) 处理 cordis.patch.yml（幂等：已有 id: auto-continue 则跳过）
$snippet = [System.IO.File]::ReadAllText($SnippetPath, $Utf8NoBom).TrimEnd() + "`n"

if (-not (Test-Path -LiteralPath $patchPath)) {
  $header = @"
# profile patch layer — 由 dsh-auto-continue 安装脚本创建
# 修改在 DSH 重启后生效。

"@
  Write-Utf8NoBom -Path $patchPath -Content ($header + $snippet)
  Write-Host "已创建 cordis.patch.yml 并写入 anti-repetition + auto-continue 挂载段"
}
else {
  $existing = [System.IO.File]::ReadAllText($patchPath, $Utf8NoBom)
  if ($existing -match '(?m)^\s*-\s*id:\s*auto-continue\s*$') {
    Write-Host "cordis.patch.yml 已包含 id: auto-continue — 跳过挂载段追加（幂等）"
  }
  else {
    $sep = if ($existing.EndsWith("`n")) { "" } else { "`n" }
    Write-Utf8NoBom -Path $patchPath -Content ($existing + $sep + "`n" + $snippet)
    Write-Host "已在 cordis.patch.yml 末尾追加 anti-repetition + auto-continue 挂载段"
  }
}

Write-Host ""
Write-Host "=== 安装完成 ==="
Write-Host "重启 DSH 生效（托盘退出才算真重启）"
Write-Host "验证方法："
Write-Host "  1) node test/check.mjs          # 静态自检 11/11"
Write-Host "  2) 重启后聊天发送长输出任务，失败/复读熔断时应自动出现来源 auto-continue 的「继续」"
Write-Host "  3) 上游超时建议合并 examples/settings-retry.snippet.yml 到 settings.yaml"
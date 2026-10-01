<#
  DJOneHub QDC507 模块 Windows 首次部署: 环境引导脚本.

  通常由同目录的 .bat 双击调用, 也可以手动执行:
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action setup
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action deploy --confirm-persistent-deploy
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action usbcfg
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action usbcfg --write --port COM8
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action flash

  职责只有三件事:
    1. 定位或自动下载 Android platform-tools (adb.exe), 解压到本目录下的 platform-tools
    2. 定位 Python 3 (>= 3.8); usbcfg 动作按需安装 pyserial
    3. 把后面的参数原样交给对应的 Python 脚本, 不做任何额外解释或改写

  例外只有 -Action flash (Flash-All.bat 双击调用): 按顺序跑 只读预检 ->
  写 USB 组合 -> 等 adb 重新枚举 -> 永久部署, 每步都看上一步的退出码, 任何一步
  失败就立刻停下, 不会在异常状态上继续往下刷. 备份与失败自动回滚仍然全部由
  flash-usbcfg.py 负责, 这里不加任何自己的写模块逻辑.

  usbnet 不是 1 (ECM) 也算"需要写入": usbnet=0 的模块 functions 里是 rmnet 而不是
  ecm, 作者部署器会静默 exit 43, 而 ecm 只能在 AT 侧用 AT+QCFG="usbnet",1 改回来.
  预检打印的 usbnet=-1 表示读不出模式, 这时不主动改它.
  flash 另外认识两个自家参数: --yes (跳过确认) 和 --force (即使当前组合已是
  目标值也重新写入并重启); 其余参数 (--port 等) 照样原样透传.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('deploy', 'usbcfg', 'setup', 'flash')]
    [string]$Action,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs = @()
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }

# Python 输出中文时避免管道乱码.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# Windows PowerShell 5.1 默认不开 TLS 1.2, 下载 dl.google.com 会失败.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
}

$PlatformToolsUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
$PythonMinimum = '3.8'

function Write-Info([string]$Message) { Write-Host "[DJOneHub] $Message" }
function Write-Warn([string]$Message) { Write-Host "[DJOneHub] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[DJOneHub] $Message" -ForegroundColor Red }

function Invoke-Native {
    # $ErrorActionPreference = 'Stop' 会把原生命令写到 stderr 的内容变成终止错误,
    # 所以调用外部程序时先临时降级, 只取退出码, 由调用方决定怎么处理.
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [string[]]$Arguments = @(),
        [switch]$Quiet
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) {
            & $Executable @Arguments 2>$null | Out-Null
        } else {
            & $Executable @Arguments
        }
        return $LASTEXITCODE
    } catch {
        return -1
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-RemoteFile([string]$Url, [string]$Destination) {
    $splat = @{ Uri = $Url; OutFile = $Destination; TimeoutSec = 600 }
    if ($PSVersionTable.PSVersion.Major -lt 6) { $splat['UseBasicParsing'] = $true }
    try {
        Invoke-WebRequest @splat
        return
    } catch {
        Write-Warn "下载失败, 换 curl.exe 重试: $($_.Exception.Message)"
    }
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path $curl) {
        $code = Invoke-Native -Executable $curl -Arguments @(
            '-L', '--fail', '--retry', '3', '--connect-timeout', '30', '--silent', '--show-error',
            '--output', $Destination, $Url
        )
        if ($code -eq 0 -and (Test-Path $Destination)) { return }
    }
    throw "无法下载 $Url ; 请检查网络或代理后重试."
}

function Install-PlatformTools([string]$AdbPath) {
    $target = Split-Path -Parent $AdbPath
    Write-Info "未找到 adb.exe, 正在自动下载 Android platform-tools ..."
    $stamp = [Guid]::NewGuid().ToString('N')
    $zip = Join-Path ([IO.Path]::GetTempPath()) "platform-tools-$stamp.zip"
    $staging = Join-Path ([IO.Path]::GetTempPath()) "platform-tools-$stamp"
    try {
        Get-RemoteFile $PlatformToolsUrl $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
        $inner = Join-Path $staging 'platform-tools'
        if (-not (Test-Path (Join-Path $inner 'adb.exe'))) {
            throw "下载到的压缩包结构异常, 缺少 platform-tools\adb.exe"
        }
        if (-not (Test-Path $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
        Copy-Item -Path (Join-Path $inner '*') -Destination $target -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $AdbPath)) { throw "platform-tools 解压后仍未找到 $AdbPath" }
}

function Resolve-PlatformTools {
    if ($env:DJONEHUB_ADB -and (Test-Path $env:DJONEHUB_ADB)) { return (Resolve-Path $env:DJONEHUB_ADB).Path }
    $candidates = @(
        (Join-Path $Root 'platform-tools\adb.exe'),
        (Join-Path $env:LOCALAPPDATA 'DJOneHub\platform-tools\adb.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    $onPath = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $errors = @()
    foreach ($candidate in $candidates) {
        try {
            Install-PlatformTools $candidate
            return $candidate
        } catch {
            $errors += "$candidate -> $($_.Exception.Message)"
        }
    }
    throw ("无法安装 platform-tools:`n" + ($errors -join "`n"))
}

function Resolve-Python {
    $candidates = New-Object System.Collections.ArrayList
    if ($env:DJONEHUB_PYTHON) { [void]$candidates.Add(@($env:DJONEHUB_PYTHON.Trim())) }
    [void]$candidates.Add(@('py', '-3'))
    [void]$candidates.Add(@('python'))
    [void]$candidates.Add(@('python3'))

    $probe = 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 9)'
    foreach ($candidate in $candidates) {
        $exe = $candidate[0]
        $exeArgs = @($candidate | Select-Object -Skip 1)
        $command = Get-Command $exe -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        if ($command.CommandType -ne 'Application') { continue }
        $code = Invoke-Native -Executable $command.Source -Arguments (@($exeArgs) + @('-c', $probe)) -Quiet
        if ($code -eq 0) {
            return @{ Exe = $command.Source; Args = $exeArgs }
        }
    }
    return $null
}

function Resolve-Pyserial($Python) {
    $exeArgs = @($Python.Args)
    if ((Invoke-Native -Executable $Python.Exe -Arguments ($exeArgs + @('-c', 'import serial')) -Quiet) -eq 0) {
        return $true
    }
    Write-Info "正在安装串口依赖 pyserial (只装到当前用户) ..."
    $attempts = @(
        @('-m', 'pip', 'install', '--user', '--disable-pip-version-check', '--no-input', 'pyserial'),
        @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'pyserial')
    )
    foreach ($attempt in $attempts) {
        if ((Invoke-Native -Executable $Python.Exe -Arguments ($exeArgs + $attempt)) -eq 0) { break }
        [void](Invoke-Native -Executable $Python.Exe -Arguments ($exeArgs + @('-m', 'ensurepip', '--default-pip')) -Quiet)
    }
    if ((Invoke-Native -Executable $Python.Exe -Arguments ($exeArgs + @('-c', 'import serial')) -Quiet) -eq 0) {
        Write-Info "pyserial 已就绪."
        return $true
    }
    return $false
}

Write-Host ""
Write-Host "DJOneHub QDC507 模块 Windows 首次部署工具" -ForegroundColor Cyan
Write-Host "包目录: $Root"
Write-Host ""

# ---- 1. adb ----
$adb = $null
if ($Action -eq 'deploy' -or $Action -eq 'setup' -or $Action -eq 'flash') {
    $adb = Resolve-PlatformTools
    Write-Info "adb: $adb"
} else {
    try {
        $adb = Resolve-PlatformTools
        Write-Info "adb: $adb"
    } catch {
        Write-Warn "未准备 adb.exe; 继续执行, 只是写入后不做 ADB 复查."
    }
}

# ---- 2. Python ----
Write-Info "检查 Python 3 (>= $PythonMinimum) ..."
$python = Resolve-Python
if (-not $python) {
    Write-Host ""
    Write-Fail "未找到可用的 Python 3 (需要 >= $PythonMinimum)。"
    Write-Host "请先安装 Python 3: https://www.python.org/downloads/windows/"
    Write-Host "安装时务必勾选 Add python.exe to PATH, 然后重新双击本脚本。"
    exit 3
}
Write-Info ("Python: " + $python.Exe + " " + ($python.Args -join ' '))

if ($Action -eq 'usbcfg' -or $Action -eq 'flash') {
    if (-not (Resolve-Pyserial $python)) {
        Write-Fail "pyserial 安装失败; 请手动执行: python -m pip install pyserial"
        exit 4
    }
}

if ($Action -eq 'setup') {
    Write-Host ""
    Write-Info "环境准备完成。接下来可以运行 Deploy-Module.bat (在此之前先跑一次 Write-USBConfig.bat --write)。"
    exit 0
}

# ---- 3. 交给 Python 脚本 ----
if ($adb) { $env:DJONEHUB_ADB = $adb }
# 统一 UTF-8: 管道或重定向时 Python 不再按本机 ANSI 代码页输出, 中文不会乱码.
$env:PYTHONIOENCODING = 'utf-8'

function Invoke-PythonScript {
    # 跑一个 Python 脚本, 返回 @{ Code = 退出码; Lines = 输出行 }.
    # -Capture: 一边照常打印给用户看, 一边把输出留一份给调用方做判断.
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Arguments = @(),
        [switch]$Capture
    )
    $scriptPath = Join-Path $Root $Name
    if (-not (Test-Path $scriptPath)) {
        Write-Fail "缺少脚本: $scriptPath (请完整解压分享包, 不要只复制单个文件)"
        return [pscustomobject]@{ Code = 2; Lines = @() }
    }
    Write-Host ""
    Write-Info ("执行: " + $Name + " " + ($Arguments -join ' '))
    Write-Host ""

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = 1
    $captured = @()
    try {
        if ($Capture) {
            & $python.Exe @($python.Args) $scriptPath @Arguments 2>&1 |
                Tee-Object -Variable captured | Out-Host
            $code = $LASTEXITCODE
        } else {
            & $python.Exe @($python.Args) $scriptPath @Arguments | Out-Host
            $code = $LASTEXITCODE
        }
    } catch {
        Write-Fail "运行 $Name 失败: $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ Code = $code; Lines = @($captured) }
}

function Get-AdbSerial {
    # 返回处于 device (已授权) 状态的设备; adb 本身跑不起来时返回空数组.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $serials = @()
    try {
        $listing = @(& $adb devices 2>$null)
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in ($listing | Select-Object -Skip 1)) {
                $parts = @([string]$line -split "`t")
                if ($parts.Count -ge 2 -and $parts[1].Trim() -eq 'device') {
                    $serials += $parts[0].Trim()
                }
            }
        }
    } catch {
        $serials = @()
    } finally {
        $ErrorActionPreference = $previous
    }
    return , $serials
}

function Wait-AdbSerial {
    param([int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $serials = Get-AdbSerial
        if ($serials.Count -ge 1) { return $serials }
        if ((Get-Date) -ge $deadline) { return @() }
        Start-Sleep -Seconds 3
    }
}

function Get-FieldFromLines {
    param([string[]]$Lines, [string]$Pattern)
    foreach ($line in $Lines) {
        $match = [regex]::Match([string]$line, $Pattern)
        if ($match.Success) { return $match.Groups[1].Value.Trim() }
    }
    return $null
}

if ($Action -eq 'flash') {
    # 一键刷机: 只读预检 -> 写 USB 组合 + 重启 -> 等 adb -> 永久部署.
    # 任何一步非 0 就立刻退出, 绝不带着坏状态继续往下走.
    $assumeYes = $false
    $forceWrite = $false
    $usbcfgArgs = New-Object System.Collections.ArrayList
    foreach ($arg in $ScriptArgs) {
        if ($arg -match '^(-y|--yes|--assume-yes)$') { $assumeYes = $true }
        elseif ($arg -match '^(--force|--force-write)$') { $forceWrite = $true }
        else { [void]$usbcfgArgs.Add($arg) }
    }
    $usbcfgArgs = @($usbcfgArgs)

    Write-Host ""
    Write-Host "===== 第 1/3 步: 只读预检 (不写入任何内容) =====" -ForegroundColor Cyan
    $preflight = Invoke-PythonScript 'flash-usbcfg.py' $usbcfgArgs -Capture
    if ($preflight.Code -ne 0) {
        Write-Host ""
        Write-Fail "预检失败 (exit $($preflight.Code)); 没有写入任何内容, 已停止."
        exit $preflight.Code
    }

    # 组合值与目标值都从脚本自己打印的 ASCII 状态行里取, 不依赖中文日志.
    $currentUsbcfg = Get-FieldFromLines $preflight.Lines 'DJONEHUB_USBCFG current=(\S+)'
    $targetUsbcfg = Get-FieldFromLines $preflight.Lines 'target=(\S+)'
    # usbnet=-1 表示脚本读不出模块的模式, 这时不主动改它.
    $usbnetValue = Get-FieldFromLines $preflight.Lines 'usbnet=(-?\d+)'
    $usbnetNeedsFix = ($usbnetValue -match '^\d+$') -and ($usbnetValue -ne '1')
    $adbSerials = Get-AdbSerial
    $alreadyTarget = ($currentUsbcfg -and $targetUsbcfg -and $currentUsbcfg -eq $targetUsbcfg)
    $needWrite = $forceWrite -or (-not $alreadyTarget) -or ($adbSerials.Count -eq 0) -or $usbnetNeedsFix

    if (-not $needWrite) {
        Write-Info "当前组合已是目标值 ($currentUsbcfg), usbnet=1, 且 adb 已看到模块; 跳过写入和重启."
    } else {
        if ($usbnetNeedsFix) {
            Write-Warn "模块 USB 网络模式是 usbnet=$usbnetValue (不是 1): 会一并改成 1 (ECM), 否则部署时作者部署器会静默 exit 43."
        }
        if (-not $assumeYes) {
            Write-Host ""
            Write-Host "即将把模块 USB 组合写成 $targetUsbcfg 并重启模块, 然后永久部署 DJOneHub Agent." -ForegroundColor Yellow
            Write-Host "原组合 ($currentUsbcfg) 已备份到 usbcfg-rollback\, 写入失败会自动回滚."
            $answer = Read-Host "确认继续? 输入 Y 回车"
            if ($answer -notmatch '^(y|yes)$') {
                Write-Host ""
                Write-Warn "已取消, 没有写入任何内容."
                exit 0
            }
        }
        Write-Host ""
        Write-Host "===== 第 2/3 步: 写入 USB 组合并重启模块 =====" -ForegroundColor Cyan
        $written = Invoke-PythonScript 'flash-usbcfg.py' @($usbcfgArgs + @('--write')) -Capture
        if ($written.Code -ne 0) {
            Write-Host ""
            Write-Fail "写入 USB 组合失败 (exit $($written.Code)); 已停止, 不会继续部署."
            Write-Host "如果模块状态异常, 双击 Restore-USBConfig.bat 可以恢复写入前的 USB 组合."
            exit $written.Code
        }
    }

    Write-Host ""
    Write-Host "===== 第 3/3 步: 等 adb 枚举并永久部署 =====" -ForegroundColor Cyan
    $serials = Wait-AdbSerial -TimeoutSeconds 120
    if ($serials.Count -eq 0) {
        Write-Host ""
        Write-Fail "adb 在 120 秒内没有发现模块设备."
        Write-Host "请重新插拔模块后重跑本脚本; 仍然不行就再跑一次并加上 --force."
        exit 8
    }

    if ($needWrite) {
        # AT+CFUN=1,1 之后模块很快重新枚举, 但它内部还没启动完: 这几十秒里作者
        # 部署器的 `mount -o remount,rw /dev/ubi0_0 /` 会返回 EBUSY, 部署失败并
        # 回滚 (实测: "mount: mounting /dev/ubi0_0 on / failed: Device or resource
        # busy"). 试过用 remount 当探针, 探针自己能过、紧接着部署器同一句还是
        # EBUSY, 所以探针不可靠; 实测重启后 30 秒左右再部署就正常, 这里固定等
        # 45 秒, 让第一次尝试就大概率成功, 真失败还有下面的重试兜底.
        $settleSeconds = 45
        Write-Info "等待模块启动完成 ($settleSeconds 秒) ..."
        Start-Sleep -Seconds $settleSeconds
    }

    # 部署失败时作者部署器会连自己的回滚一起跑, 结果是模块回到"没有 Agent"的
    # 状态, 所以失败后重试一次是安全的, 也是能救回来的.
    $deployed = $null
    foreach ($attempt in 1..2) {
        if ($attempt -eq 2) {
            Write-Warn "上一次部署失败; 等 30 秒后自动重试一次."
            Start-Sleep -Seconds 30
        }
        $deployed = Invoke-PythonScript 'deploy_qdc507_windows.py' @('--confirm-persistent-deploy')
        if ($deployed.Code -eq 0) { break }
    }

    Write-Host ""
    if ($deployed.Code -eq 0) {
        Write-Host "全部完成: USB 组合已生效, DJOneHub Agent 已永久部署." -ForegroundColor Green
        Write-Host "接下来把模块插到已安装并授权 DJOneHub 的 iPhone / iPad 上即可."
    } else {
        Write-Fail "部署失败 (exit $($deployed.Code))."
        Write-Host "失败时部署器会把模块回滚到没有 Agent 的状态, 所以模块现在是干净的,"
        Write-Host "重新插拔后直接重跑本脚本即可再次尝试."
    }
    exit $deployed.Code
}

$targetScript = if ($Action -eq 'deploy') { 'deploy_qdc507_windows.py' } else { 'flash-usbcfg.py' }
exit (Invoke-PythonScript $targetScript $ScriptArgs).Code

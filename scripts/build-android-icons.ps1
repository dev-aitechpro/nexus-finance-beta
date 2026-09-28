<#
.SYNOPSIS
  Конвертирует иконку приложения public/favicon.ico в Android-mipmap'ы.

.DESCRIPTION
  Нужен потому, что Android в res/mipmap-* требует PNG, а в проекте есть только
  favicon.ico. Шаблон `npx cap add android` кладёт в mipmap-* дефолтные иконки
  Capacitor (зелёный android-робот) — этот скрипт заменяет их на иконку NEXUS
  Finance.

  Новых зависимостей нет: только System.Drawing из .NET Framework / Windows
  (Add-Type -AssemblyName System.Drawing). Иконка читается напрямую из контейнера
  ICO — System.Drawing.Icon.ToBitmap() на 256x256 падает с
  ArgumentOutOfRangeException, а у нашей иконки внутри ICO лежит PNG
  (icon type 1, 1 картинка 256x256 bpp=32, payload со сдвигом 22 — сигнатура
  89 50 4E 47), поэтому мы вырезаем payload и грузим его как Bitmap.

  Что делаем:
   * ic_launcher.png         — квадратная иконка 48/72/96/144/192 (mdpi..xxxhdpi)
   * ic_launcher_round.png   — то же, но с круговой альфа-маской
   * ic_launcher_foreground.png — 108/162/216/324/432 (adaptive-icon foreground:
     слой 108dp при иконке 48dp, логотип внутри safe zone 66dp)
   * values/ic_launcher_background.xml — цвет подложки adaptive-icon, берётся
     как самый частый цвет непрозрачных пикселей исходной иконки

  Уменьшение делается прогрессивным делением пополам (256->128->64->48, а не
  256->48 одним бикубиком) — так мелкие плотности заметно чище.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-android-icons.ps1
#>
[CmdletBinding()]
param(
    # Исходная иконка (.ico). По умолчанию <корень проекта>/public/favicon.ico
    [string] $Ico,
    # Куда класть mipmap-*. По умолчанию <корень проекта>/android/app/src/main/res
    [string] $ResDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot недоступен в значениях по умолчанию param() при запуске через
# `powershell -File`, поэтому вычисляем корень здесь.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Ico)    { $Ico    = Join-Path $here '..\public\favicon.ico' }
if (-not $ResDir) { $ResDir = Join-Path $here '..\android\app\src\main\res' }

$Ico    = (Resolve-Path $Ico).Path
$ResDir = (Resolve-Path $ResDir).Path

# ---------------------------------------------------------------- ICO-разбор
function Get-IconMaster {
    <# Возвращает Bitmap максимального разрешения из .ico.
       Поддерживает и PNG-payload (наш случай), и классический BMP-DIB. #>
    $bytes = [System.IO.File]::ReadAllBytes($Ico)
    if ($bytes.Length -lt 6) { throw "ICO слишком короткий: $Ico" }
    $count = [BitConverter]::ToUInt16($bytes, 4)
    Write-Host "ICO: записей $count"

    $best = $null
    for ($i = 0; $i -lt $count; $i++) {
        $off = 6 + 16 * $i
        $w = if ($bytes[$off] -eq 0) { 256 } else { [int]$bytes[$off] }
        $h = if ($bytes[$off + 1] -eq 0) { 256 } else { [int]$bytes[$off + 1] }
        $bpp = [BitConverter]::ToUInt16($bytes, $off + 6)
        $len = [BitConverter]::ToUInt32($bytes, $off + 8)
        $pos = [BitConverter]::ToUInt32($bytes, $off + 12)
        Write-Host ("  [$i] {0}x{1} bpp={2} bytes={3} off={4}" -f $w, $h, $bpp, $len, $pos)
        if ($null -eq $best -or $w -gt $best.Width) {
            $best = [pscustomobject]@{ W = $w; H = $h; Off = [int]$pos; Len = [int]$len }
        }
    }
    if ($null -eq $best) { throw "В ICO нет ни одной картинки" }

    $payload = New-Object byte[] $best.Len
    [Array]::Copy($bytes, $best.Off, $payload, 0, $best.Len)

    $isPng = ($payload.Length -gt 8 -and $payload[0] -eq 0x89 -and $payload[1] -eq 0x50 -and
              $payload[2] -eq 0x4E -and $payload[3] -eq 0x47)
    if ($isPng) {
        Write-Host "  payload внутри ICO — PNG, грузим напрямую (Icon.ToBitmap() на 256x256 не работает)"
        $ms = New-Object System.IO.MemoryStream(, $payload)
        $bmp = New-Object System.Drawing.Bitmap($ms)
        return $bmp
    }

    # BMP-путь: заворачиваем в Icon и рисуем через Graphics (ToBitmap() падает)
    $ms2 = New-Object System.IO.MemoryStream(, $payload)
    $icon = New-Object System.Drawing.Icon($ms2, $best.W, $best.H)
    $dst = New-Object System.Drawing.Bitmap($best.W, $best.H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($icon, (New-Object System.Drawing.Rectangle(0, 0, $best.W, $best.H)))
    $g.Dispose(); $icon.Dispose(); $ms2.Dispose()
    return $dst
}

# ------------------------------------------------------------- масштабирование
function New-Scaled {
    <# Прогрессивное уменьшение: пока текущий размер > 2*цель — делим пополам,
       последний шаг — бикубик. Всегда Format32bppArgb, чтобы не потерять альфу. #>
    param([System.Drawing.Bitmap] $Src, [int] $W, [int] $H)
    $curW = $Src.Width; $curH = $Src.Height
    $cur = $Src
    while ($curW -gt ($W * 2) -and $curH -gt ($H * 2)) {
        $nw = [Math]::Max($W, [int]($curW / 2))
        $nh = [Math]::Max($H, [int]($curH / 2))
        $cur = Resize-Bmp $cur $nw $nh
        $curW = $nw; $curH = $nh
    }
    if ($curW -ne $W -or $curH -ne $H) { $cur = Resize-Bmp $cur $W $H }
    return $cur
}

function Resize-Bmp {
    param([System.Drawing.Bitmap] $Src, [int] $W, [int] $H)
    $b = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode     = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode       = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode         = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality    = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($Src, (New-Object System.Drawing.Rectangle(0, 0, $W, $H)))
    $g.Dispose()
    return $b
}

function New-Round {
    <# Круглая иконка: рисуем маску крупнее (x4) со сглаживанием
       и потом ужимаем — так край получается мягким, без лесенки. #>
    param([System.Drawing.Bitmap] $Src, [int] $Size)
    $ss = 4
    $big = New-Scaled $Src ($Size * $ss) ($Size * $ss)
    $b = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    # Апсмплинг x4: сперва ужимаем картинку с AntiAlias, потом дорисовываем круглую
    # альфу — так край не рассыпается на «пилу», как при маске радиусом ровно в Size.
    $g.DrawImage($big,
        [System.Drawing.Rectangle]::new(0, 0, $Size, $Size),
        [System.Drawing.Rectangle]::new(0, 0, $Size * $ss, $Size * $ss),
        [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $big.Dispose()
    # применяем круглую альфу попиксельно
    $r = $Size / 2.0
    $lock = $b.LockBits((New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)),
        [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $lock.Stride
        $data = New-Object byte[] ([Math]::Abs($stride) * $Size)
        [System.Runtime.InteropServices.Marshal]::Copy($lock.Scan0, $data, 0, $data.Length)
        for ($y = 0; $y -lt $Size; $y++) {
            for ($x = 0; $x -lt $Size; $x++) {
                $dx = $x + 0.5 - $r; $dy = $y + 0.5 - $r
                $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
                $edge = $r - $dist          # >0 внутри
                if ($edge -le 0) {
                    $data[$y * $stride + $x * 4 + 3] = 0
                } elseif ($edge -lt 1) {
                    $i = $y * $stride + $x * 4 + 3
                    $data[$i] = [byte]([Math]::Round($data[$i] * $edge))
                }
            }
        }
        [System.Runtime.InteropServices.Marshal]::Copy($data, 0, $lock.Scan0, $data.Length)
    } finally { $b.UnlockBits($lock) }
    return $b
}

function Save-Png {
    param([System.Drawing.Bitmap] $Bmp, [string] $Path)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $Bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $kb = [Math]::Round((Get-Item $Path).Length / 1KB, 1)
    Write-Host ("  -> {0,-58} {1,3}x{1,-3} {2} KB" -f ($Path.Substring($ResDir.Length + 1)), $Bmp.Width, $kb)
}

# ------------------------------------------------------------------- основной ход
Write-Host "Источник : $Ico"
$master = Get-IconMaster
Write-Host "Мастер   : $($master.Width)x$($master.Height)"

# Самый частый цвет непрозрачных пикселей -> цвет подложки adaptive-icon
$hist = @{}
for ($y = 0; $y -lt $master.Height; $y += 2) {
    for ($x = 0; $x -lt $master.Width; $x += 2) {
        $c = $master.GetPixel($x, $y)
        if ($c.A -lt 200) { continue }
        $k = '#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B
        if ($hist.ContainsKey($k)) { $hist[$k]++ } else { $hist[$k] = 1 }
    }
}
$bg = ($hist.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
Write-Host "Цвет подложки adaptive-icon: $bg (самый частый непрозрачный цвет)"

# Плотности: обычная иконка (launcher 48dp) и foreground (adaptive-icon 108dp)
$dpi = [ordered]@{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }

foreach ($k in $dpi.Keys) {
    $s = $dpi[$k]
    $dir = Join-Path $ResDir "mipmap-$k"

    $sq = New-Scaled $master $s $s
    Save-Png $sq (Join-Path $dir 'ic_launcher.png')
    $sq.Dispose()

    $rd = New-Round $master $s
    Save-Png $rd (Join-Path $dir 'ic_launcher_round.png')
    $rd.Dispose()

    # adaptive-icon foreground. Слой foreground у adaptive-icon — 108dp, а обычная
    # иконка лаунчера — 48dp, т.е. холст в 108/48 = 2.25 раза больше. Логотип
    # кладём в «safe zone» 66dp (те же пропорции, что у шаблона Capacitor:
    # 108/162/216/324/432 px для mdpi..xxxhdpi) и центрируем.
    $fs = [int][Math]::Round($s * 2.25)
    $logo = [int][Math]::Round($s * 1.375)   # = 66dp
    $fg = New-Object System.Drawing.Bitmap($fs, $fs, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($fg)
    $g.Clear([System.Drawing.Color]::Transparent)
    $inner = New-Scaled $master $logo $logo
    $off = [int][Math]::Round(($fs - $logo) / 2.0)
    $g.DrawImage($inner, $off, $off, $logo, $logo)
    $g.Dispose(); $inner.Dispose()
    Save-Png $fg (Join-Path $dir 'ic_launcher_foreground.png')
    $fg.Dispose()
}

# Цвет подложки adaptive-icon (его читает mipmap-anydpi-v26/ic_launcher.xml)
$colorFile = Join-Path $ResDir 'values\ic_launcher_background.xml'
$colorDir = Split-Path -Parent $colorFile
if (-not (Test-Path $colorDir)) { New-Item -ItemType Directory -Force -Path $colorDir | Out-Null }
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Сгенерировано scripts/build-android-icons.ps1: цвет подложки adaptive-icon
     взят из доминирующего цвета public/favicon.ico. -->
<resources>
    <color name="ic_launcher_background">$bg</color>
</resources>
"@
# Без BOM: Set-Content -Encoding UTF8 в PowerShell 5.1 пишет BOM, а aapt2/
# Android Studio к такому относятся по-разному — пишем чистый UTF-8.
[System.IO.File]::WriteAllText($colorFile, $xml, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  -> values\ic_launcher_background.xml = $bg"

$master.Dispose()
Write-Host "Готово."

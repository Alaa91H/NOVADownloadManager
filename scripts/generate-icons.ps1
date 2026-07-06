# scripts/generate-icons.ps1
# Generates all NOVA project icons from the NOVA logo specification.
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
#
# After changing the logo, also refresh the macOS/mobile icon sets from the
# 1024 px master:
#   npx tauri icon src-tauri/icons/icon.png
#   powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1   # restore size-adaptive PNG/ICO

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# ---------------------------------------------------------------------------
# Core drawing – renders the NOVA logo at any pixel size onto $g.
# Design: black circle, white download arrow punching through a double bar
# (black keyline separates the arrow tip from the bars), NOVA wordmark
# justified to the bar width.
# Layout (all values proportional to $s):
#   Circle pad      1 %
#   Shaft top      13.5 %  width 14.2 %
#   Head base      31 %    width 33.4 %  tip 53.5 %
#   Bars top       46.5 %  width 54 %    height 3.6 % each, gap 1 %
#   NOVA text top  58 %    height 12.5 % (>= 40 px only)
# ---------------------------------------------------------------------------
function Draw-NovaLogo([System.Drawing.Graphics]$g, [int]$s) {
    $cx = [float]($s / 2.0)

    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $bBlack = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
    $bWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    # Circle
    $pad = [float]($s * 0.01)
    $g.FillEllipse($bBlack, $pad, $pad, [float]($s - 2 * $pad), [float]($s - 2 * $pad))

    if ($s -ge 20) {
        # Double bar (rounded ends)
        $bw  = [float]($s * 0.540)
        $bh  = [float]([Math]::Max(2.0, $s * 0.038))
        $bg  = [float]([Math]::Max(1.0, $s * 0.008))
        $b1t = [float]($s * 0.465)
        $br  = [float]([Math]::Max(1.0, $bh * 0.35))
        foreach ($bt in @($b1t, ($b1t + $bh + $bg))) {
            $path = New-Object System.Drawing.Drawing2D.GraphicsPath
            $path.AddArc([float]($cx - $bw / 2), $bt, (2 * $br), (2 * $br), 180, 90)
            $path.AddArc([float]($cx + $bw / 2 - 2 * $br), $bt, (2 * $br), (2 * $br), 270, 90)
            $path.AddArc([float]($cx + $bw / 2 - 2 * $br), ($bt + $bh - 2 * $br), (2 * $br), (2 * $br), 0, 90)
            $path.AddArc([float]($cx - $bw / 2), ($bt + $bh - 2 * $br), (2 * $br), (2 * $br), 90, 90)
            $path.CloseFigure()
            $g.FillPath($bWhite, $path)
            $path.Dispose()
        }

        # Download arrow (shaft + head as one silhouette) drawn over the bars.
        # The black outline creates the punched-through keyline gap.
        $sw   = [float]($s * 0.142)   # shaft width
        $st   = [float]($s * 0.135)   # shaft top
        $hb   = [float]($s * 0.310)   # head base (shaft bottom)
        $hw   = [float]($s * 0.334)   # head width
        $htip = [float]($s * 0.558)   # tip (pokes just below the bars)
        $pts  = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new([float]($cx - $sw / 2), $st),
            [System.Drawing.PointF]::new([float]($cx + $sw / 2), $st),
            [System.Drawing.PointF]::new([float]($cx + $sw / 2), $hb),
            [System.Drawing.PointF]::new([float]($cx + $hw / 2), $hb),
            [System.Drawing.PointF]::new([float]$cx, $htip),
            [System.Drawing.PointF]::new([float]($cx - $hw / 2), $hb),
            [System.Drawing.PointF]::new([float]($cx - $sw / 2), $hb)
        )
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, [float]([Math]::Max(1.0, $s * 0.016)))
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPolygon($pen, $pts)
        $g.FillPolygon($bWhite, $pts)
        $pen.Dispose()

        # "NOVA" wordmark justified to the bar width (only at >= 40 px)
        if ($s -ge 40) {
            $family = $null
            foreach ($name in @('Arial Black', 'Segoe UI Black', 'Impact', 'Arial')) {
                try {
                    $candidate = New-Object System.Drawing.FontFamily($name)
                    $family = $candidate; break
                } catch { }
            }
            $textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
            $textPath.AddString(
                'NOVA',
                $family,
                [int][System.Drawing.FontStyle]::Bold,
                [float]($s * 0.2),
                [System.Drawing.PointF]::new(0, 0),
                [System.Drawing.StringFormat]::GenericTypographic)
            $bounds = $textPath.GetBounds()

            $targetW = [float]($s * 0.540)
            $targetH = [float]($s * 0.125)
            $tm = New-Object System.Drawing.Drawing2D.Matrix
            $tm.Translate([float]($cx - $targetW / 2), [float]($s * 0.580))
            $tm.Scale([float]($targetW / $bounds.Width), [float]($targetH / $bounds.Height))
            $tm.Translate(-$bounds.X, -$bounds.Y)
            $textPath.Transform($tm)
            $g.FillPath($bWhite, $textPath)
            $tm.Dispose()
            $textPath.Dispose()
            $family.Dispose()
        }
    }

    $bBlack.Dispose()
    $bWhite.Dispose()
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Ensure-Dir([string]$path) {
    if (-not (Test-Path $path)) { New-Item -ItemType Directory -Force $path | Out-Null }
}

function New-PngIcon([int]$size, [string]$outPath) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    Draw-NovaLogo $g $size
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  $outPath"
}

function New-IcoIcon([string]$outPath, [int[]]$sizes) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $blobs = @()
    foreach ($sz in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        Draw-NovaLogo $g $sz
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $blobs += , $ms.ToArray()
        $bmp.Dispose()
        $ms.Dispose()
    }

    # Build ICO file (modern format – PNG frames embedded directly)
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint16]0)              # reserved
    $bw.Write([uint16]1)              # type = 1 (ICO)
    $bw.Write([uint16]$sizes.Count)

    $dataOffset = [uint32](6 + $sizes.Count * 16)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $w = if ($sizes[$i] -ge 256) { [byte]0 } else { [byte]$sizes[$i] }
        $h = if ($sizes[$i] -ge 256) { [byte]0 } else { [byte]$sizes[$i] }
        $bw.Write($w); $bw.Write($h)
        $bw.Write([byte]0); $bw.Write([byte]0)   # colorCount, reserved
        $bw.Write([uint16]1)                       # planes
        $bw.Write([uint16]32)                      # bit depth
        $bw.Write([uint32]$blobs[$i].Length)
        $bw.Write($dataOffset)
        $dataOffset += [uint32]$blobs[$i].Length
    }
    foreach ($blob in $blobs) { $bw.Write($blob) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($outPath, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose()
    Write-Host "  $outPath"
}

# ---------------------------------------------------------------------------
# Generate icons
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Tauri app icons (src-tauri/icons/)..."
$t = "$root\src-tauri\icons"
New-PngIcon  32  "$t\32x32.png"
New-PngIcon  64  "$t\64x64.png"
New-PngIcon 128  "$t\128x128.png"
New-PngIcon 256  "$t\128x128@2x.png"
New-PngIcon 1024 "$t\icon.png"
New-PngIcon  50  "$t\StoreLogo.png"
New-PngIcon  30  "$t\Square30x30Logo.png"
New-PngIcon  44  "$t\Square44x44Logo.png"
New-PngIcon  71  "$t\Square71x71Logo.png"
New-PngIcon  89  "$t\Square89x89Logo.png"
New-PngIcon 107  "$t\Square107x107Logo.png"
New-PngIcon 142  "$t\Square142x142Logo.png"
New-PngIcon 150  "$t\Square150x150Logo.png"
New-PngIcon 284  "$t\Square284x284Logo.png"
New-PngIcon 310  "$t\Square310x310Logo.png"
New-IcoIcon "$t\icon.ico" @(16, 24, 32, 48, 64, 128, 256)
Write-Host "  icon.icns: refresh with 'npx tauri icon src-tauri/icons/icon.png' (macOS)"

Write-Host ""
Write-Host "==> Frontend asset (src/assets/logo.png)..."
New-PngIcon 512 "$root\src\assets\logo.png"

Write-Host ""
Write-Host "==> Browser extension icons (browser-extension/public/icons/)..."
$e = "$root\browser-extension\public\icons"
New-PngIcon  16  "$e\icon-16.png"
New-PngIcon  32  "$e\icon-32.png"
New-PngIcon  48  "$e\icon-48.png"
New-PngIcon 128  "$e\icon-128.png"
New-PngIcon 512  "$e\icon.png"
New-PngIcon 512  "$e\logo.png"
New-IcoIcon "$e\icon.ico" @(16, 32, 48, 128)

Write-Host ""
Write-Host "==> Public icon (public/icon.ico)..."
New-IcoIcon "$root\public\icon.ico" @(16, 24, 32, 48, 64, 128, 256)

Write-Host ""
Write-Host "All icons generated successfully."

# scripts/generate-icons.ps1
# Generates all NOVA project artwork from the canonical branding source folder.
#
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
#
# The default source folder is tracked in this repository:
#   branding\source

param(
    [string]$LogoDir = ""
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if ([string]::IsNullOrWhiteSpace($LogoDir)) {
    $LogoDir = Join-Path $root 'branding\source'
}

$LogoDir = [System.IO.Path]::GetFullPath($LogoDir)
$IconSourcePath = Join-Path $LogoDir 'app-icon.png'
$BannerSourcePath = Join-Path $LogoDir 'installer-banner.png'
$ProfileSourcePath = Join-Path $LogoDir 'profile-logo.png'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$NsisArtworkScale = 4
$NsisHeaderWidth = 150 * $NsisArtworkScale
$NsisHeaderHeight = 57 * $NsisArtworkScale
$NsisSidebarWidth = 164 * $NsisArtworkScale
$NsisSidebarHeight = 314 * $NsisArtworkScale
# Icon glyphs are trimmed to their opaque bounding box and scaled to fill the
# canvas leaving only this fractional margin, so tray/taskbar icons are not
# dwarfed by transparent padding baked into the source art.
$IconContentMargin = 0.02
$script:TrimmedCache = @{}

function Assert-File([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "$label was not found at $path"
    }
}

Assert-File $IconSourcePath 'Icon source'
Assert-File $BannerSourcePath 'Installer banner source'
Assert-File $ProfileSourcePath 'Profile logo source'

function Ensure-Dir([string]$path) {
    if (-not [string]::IsNullOrWhiteSpace($path) -and -not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function New-Graphics([System.Drawing.Bitmap]$bitmap) {
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    return $g
}

function Draw-ImageContain(
    [System.Drawing.Graphics]$g,
    [System.Drawing.Image]$image,
    [float]$x,
    [float]$y,
    [float]$width,
    [float]$height,
    [float]$padding = 0
) {
    $innerW = [Math]::Max(1.0, $width - ($padding * 2))
    $innerH = [Math]::Max(1.0, $height - ($padding * 2))
    $scale = [Math]::Min($innerW / $image.Width, $innerH / $image.Height)
    $drawW = [float]($image.Width * $scale)
    $drawH = [float]($image.Height * $scale)
    $dx = [float]($x + $padding + (($innerW - $drawW) / 2))
    $dy = [float]($y + $padding + (($innerH - $drawH) / 2))
    $dest = [System.Drawing.RectangleF]::new($dx, $dy, $drawW, $drawH)
    $g.DrawImage($image, $dest)
}

function Draw-ImageCover(
    [System.Drawing.Graphics]$g,
    [System.Drawing.Image]$image,
    [float]$x,
    [float]$y,
    [float]$width,
    [float]$height,
    [float]$alignX = 0.5,
    [float]$alignY = 0.5
) {
    $scale = [Math]::Max($width / $image.Width, $height / $image.Height)
    $drawW = [float]($image.Width * $scale)
    $drawH = [float]($image.Height * $scale)
    $dx = [float]($x - (($drawW - $width) * $alignX))
    $dy = [float]($y - (($drawH - $height) * $alignY))
    $dest = [System.Drawing.RectangleF]::new($dx, $dy, $drawW, $drawH)
    $g.DrawImage($image, $dest)
}

# Returns the source image cropped to its opaque bounding box (transparent
# margin removed), cached per source path. Falls back to the original image if
# it is fully transparent.
function Get-TrimmedBitmap([string]$sourcePath) {
    if ($script:TrimmedCache.ContainsKey($sourcePath)) { return $script:TrimmedCache[$sourcePath] }
    $img = [System.Drawing.Bitmap]::FromFile($sourcePath)
    $w = $img.Width
    $h = $img.Height
    $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
    $data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $buffer = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
    $img.UnlockBits($data)
    $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $h; $y++) {
        $rowStart = $y * $stride
        for ($x = 0; $x -lt $w; $x++) {
            if ($buffer[$rowStart + $x * 4 + 3] -gt 16) {
                if ($x -lt $minX) { $minX = $x }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    if ($maxX -lt $minX) {
        $script:TrimmedCache[$sourcePath] = $img
        return $img
    }
    $cropW = $maxX - $minX + 1
    $cropH = $maxY - $minY + 1
    $crop = New-Object System.Drawing.Bitmap($cropW, $cropH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $cg = [System.Drawing.Graphics]::FromImage($crop)
    $cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $cg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $cg.DrawImage($img, [System.Drawing.Rectangle]::new(0, 0, $cropW, $cropH), [System.Drawing.Rectangle]::new($minX, $minY, $cropW, $cropH), [System.Drawing.GraphicsUnit]::Pixel)
    $cg.Dispose()
    $img.Dispose()
    $script:TrimmedCache[$sourcePath] = $crop
    return $crop
}

function New-PngBlob([int]$width, [int]$height, [string]$sourcePath, [float]$padding = 0) {
    $img = Get-TrimmedBitmap $sourcePath
    $bmp = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-Graphics $bmp
    $g.Clear([System.Drawing.Color]::Transparent)
    $margin = $padding + ([Math]::Min($width, $height) * $IconContentMargin)
    Draw-ImageContain $g $img 0 0 $width $height $margin
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $bytes = $ms.ToArray()
    $ms.Dispose()
    return ,$bytes
}

function New-PngIcon([int]$size, [string]$outPath, [string]$sourcePath = $IconSourcePath, [float]$padding = 0) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $bytes = New-PngBlob $size $size $sourcePath $padding
    [System.IO.File]::WriteAllBytes($outPath, $bytes)
    Write-Host "  $outPath"
}

function New-IcoIcon([string]$outPath, [int[]]$sizes) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $blobs = New-Object System.Collections.ArrayList
    foreach ($sz in $sizes) {
        [void]$blobs.Add((New-PngBlob $sz $sz $IconSourcePath 0))
    }

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$sizes.Count)

    $dataOffset = [uint32](6 + $sizes.Count * 16)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $w = if ($sizes[$i] -ge 256) { [byte]0 } else { [byte]$sizes[$i] }
        $h = if ($sizes[$i] -ge 256) { [byte]0 } else { [byte]$sizes[$i] }
        $bw.Write($w)
        $bw.Write($h)
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([uint32]$blobs[$i].Length)
        $bw.Write($dataOffset)
        $dataOffset += [uint32]$blobs[$i].Length
    }
    foreach ($blob in $blobs) {
        $bw.Write([byte[]]$blob)
    }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($outPath, $ms.ToArray())
    $bw.Dispose()
    $ms.Dispose()
    Write-Host "  $outPath"
}

function Write-Ascii([System.IO.Stream]$stream, [string]$text) {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($text)
    $stream.Write($bytes, 0, $bytes.Length)
}

function Write-BigEndianUInt32([System.IO.Stream]$stream, [uint32]$value) {
    $bytes = [byte[]]@(
        (($value -shr 24) -band 0xff),
        (($value -shr 16) -band 0xff),
        (($value -shr 8) -band 0xff),
        ($value -band 0xff)
    )
    $stream.Write($bytes, 0, 4)
}

function New-IcnsIcon([string]$outPath) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $specs = @(
        @{ Type = 'icp4'; Size = 16 },
        @{ Type = 'icp5'; Size = 32 },
        @{ Type = 'icp6'; Size = 64 },
        @{ Type = 'ic07'; Size = 128 },
        @{ Type = 'ic08'; Size = 256 },
        @{ Type = 'ic09'; Size = 512 },
        @{ Type = 'ic10'; Size = 1024 }
    )

    $chunks = New-Object System.Collections.ArrayList
    foreach ($spec in $specs) {
        [void]$chunks.Add([PSCustomObject]@{
            Type = $spec.Type
            Data = (New-PngBlob $spec.Size $spec.Size $IconSourcePath 0)
        })
    }

    [uint32]$totalLength = 8
    foreach ($chunk in $chunks) {
        $totalLength += [uint32](8 + $chunk.Data.Length)
    }

    $fs = [System.IO.File]::Open($outPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
        Write-Ascii $fs 'icns'
        Write-BigEndianUInt32 $fs $totalLength
        foreach ($chunk in $chunks) {
            Write-Ascii $fs $chunk.Type
            Write-BigEndianUInt32 $fs ([uint32](8 + $chunk.Data.Length))
            $fs.Write([byte[]]$chunk.Data, 0, $chunk.Data.Length)
        }
    } finally {
        $fs.Dispose()
    }
    Write-Host "  $outPath"
}

function New-InstallerHeader([string]$outPath) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $banner = [System.Drawing.Image]::FromFile($BannerSourcePath)
    $bmp = New-Object System.Drawing.Bitmap($NsisHeaderWidth, $NsisHeaderHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = New-Graphics $bmp
    $g.Clear([System.Drawing.Color]::FromArgb(4, 7, 12))
    Draw-ImageCover $g $banner 0 0 $NsisHeaderWidth $NsisHeaderHeight 0.46 0.5
    $g.Dispose()
    $banner.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    Write-Host "  $outPath"
}

function New-BrandFont([float]$size, [System.Drawing.FontStyle]$style) {
    foreach ($name in @('Segoe UI Semibold', 'Segoe UI', 'Arial')) {
        try {
            return [System.Drawing.Font]::new($name, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
        } catch { }
    }
    return [System.Drawing.Font]::new([System.Drawing.FontFamily]::GenericSansSerif, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-InstallerSidebar([string]$outPath) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $banner = [System.Drawing.Image]::FromFile($BannerSourcePath)
    $profile = [System.Drawing.Image]::FromFile($ProfileSourcePath)
    $bmp = New-Object System.Drawing.Bitmap($NsisSidebarWidth, $NsisSidebarHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = New-Graphics $bmp

    $g.Clear([System.Drawing.Color]::FromArgb(4, 7, 12))
    Draw-ImageCover $g $banner 0 0 $NsisSidebarWidth $NsisSidebarHeight 0.86 0.5

    $overlay = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(166, 3, 6, 12))
    $g.FillRectangle($overlay, 0, 0, $NsisSidebarWidth, $NsisSidebarHeight)
    $overlay.Dispose()

    $logoClip = New-Object System.Drawing.Drawing2D.GraphicsPath
    $logoClip.AddEllipse((22 * $NsisArtworkScale), (34 * $NsisArtworkScale), (120 * $NsisArtworkScale), (120 * $NsisArtworkScale))
    $g.SetClip($logoClip)
    Draw-ImageContain $g $profile (22 * $NsisArtworkScale) (34 * $NsisArtworkScale) (120 * $NsisArtworkScale) (120 * $NsisArtworkScale) 0
    $g.ResetClip()
    $logoClip.Dispose()

    $titleFont = New-BrandFont (25 * $NsisArtworkScale) ([System.Drawing.FontStyle]::Bold)
    $subFont = New-BrandFont (10 * $NsisArtworkScale) ([System.Drawing.FontStyle]::Regular)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 248, 255))
    $muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(175, 207, 226))
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center

    $g.DrawString('NOVA', $titleFont, $white, [System.Drawing.RectangleF]::new(0, (168 * $NsisArtworkScale), $NsisSidebarWidth, (32 * $NsisArtworkScale)), $format)
    $g.DrawString('Download Manager', $subFont, $muted, [System.Drawing.RectangleF]::new(0, (199 * $NsisArtworkScale), $NsisSidebarWidth, (20 * $NsisArtworkScale)), $format)

    $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(52, 223, 237), (1.4 * $NsisArtworkScale))
    $g.DrawLine($linePen, (38 * $NsisArtworkScale), (252 * $NsisArtworkScale), (126 * $NsisArtworkScale), (252 * $NsisArtworkScale))
    $g.DrawLine($linePen, (54 * $NsisArtworkScale), (266 * $NsisArtworkScale), (110 * $NsisArtworkScale), (266 * $NsisArtworkScale))

    $linePen.Dispose()
    $format.Dispose()
    $white.Dispose()
    $muted.Dispose()
    $titleFont.Dispose()
    $subFont.Dispose()
    $g.Dispose()
    $banner.Dispose()
    $profile.Dispose()

    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    Write-Host "  $outPath"
}

function Write-WebManifest([string]$outPath) {
    Ensure-Dir (Split-Path $outPath -Parent)
    $manifest = @'
{
  "name": "NOVA Download Manager",
  "short_name": "NOVA",
  "icons": [
    {
      "src": "/android-chrome-192x192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/android-chrome-512x512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ],
  "theme_color": "#050507",
  "background_color": "#050507",
  "display": "standalone"
}
'@
    [System.IO.File]::WriteAllText($outPath, $manifest, $Utf8NoBom)
    Write-Host "  $outPath"
}

Write-Host ""
Write-Host "Using logo assets from $LogoDir"

Write-Host ""
Write-Host "==> Tauri app icons (src-tauri/icons/)..."
$t = Join-Path $root 'src-tauri\icons'
New-PngIcon 32 "$t\32x32.png"
New-PngIcon 64 "$t\64x64.png"
New-PngIcon 128 "$t\128x128.png"
New-PngIcon 256 "$t\128x128@2x.png"
New-PngIcon 1024 "$t\icon.png"
New-PngIcon 50 "$t\StoreLogo.png"
New-PngIcon 30 "$t\Square30x30Logo.png"
New-PngIcon 44 "$t\Square44x44Logo.png"
New-PngIcon 71 "$t\Square71x71Logo.png"
New-PngIcon 89 "$t\Square89x89Logo.png"
New-PngIcon 107 "$t\Square107x107Logo.png"
New-PngIcon 142 "$t\Square142x142Logo.png"
New-PngIcon 150 "$t\Square150x150Logo.png"
New-PngIcon 284 "$t\Square284x284Logo.png"
New-PngIcon 310 "$t\Square310x310Logo.png"
New-IcoIcon "$t\icon.ico" @(16, 24, 32, 48, 64, 128, 256)
New-IcnsIcon "$t\icon.icns"

Write-Host ""
Write-Host "==> Tauri iOS icons (src-tauri/icons/ios/)..."
$ios = Join-Path $t 'ios'
New-PngIcon 20 "$ios\AppIcon-20x20@1x.png"
New-PngIcon 40 "$ios\AppIcon-20x20@2x.png"
New-PngIcon 40 "$ios\AppIcon-20x20@2x-1.png"
New-PngIcon 60 "$ios\AppIcon-20x20@3x.png"
New-PngIcon 29 "$ios\AppIcon-29x29@1x.png"
New-PngIcon 58 "$ios\AppIcon-29x29@2x.png"
New-PngIcon 58 "$ios\AppIcon-29x29@2x-1.png"
New-PngIcon 87 "$ios\AppIcon-29x29@3x.png"
New-PngIcon 40 "$ios\AppIcon-40x40@1x.png"
New-PngIcon 80 "$ios\AppIcon-40x40@2x.png"
New-PngIcon 80 "$ios\AppIcon-40x40@2x-1.png"
New-PngIcon 120 "$ios\AppIcon-40x40@3x.png"
New-PngIcon 120 "$ios\AppIcon-60x60@2x.png"
New-PngIcon 180 "$ios\AppIcon-60x60@3x.png"
New-PngIcon 76 "$ios\AppIcon-76x76@1x.png"
New-PngIcon 152 "$ios\AppIcon-76x76@2x.png"
New-PngIcon 167 "$ios\AppIcon-83.5x83.5@2x.png"
New-PngIcon 1024 "$ios\AppIcon-512@2x.png"

Write-Host ""
Write-Host "==> Tauri Android icons (src-tauri/icons/android/)..."
$android = Join-Path $t 'android'
$densities = @(
    @{ Dir = 'mipmap-mdpi'; Launcher = 48; Foreground = 108 },
    @{ Dir = 'mipmap-hdpi'; Launcher = 72; Foreground = 162 },
    @{ Dir = 'mipmap-xhdpi'; Launcher = 96; Foreground = 216 },
    @{ Dir = 'mipmap-xxhdpi'; Launcher = 144; Foreground = 324 },
    @{ Dir = 'mipmap-xxxhdpi'; Launcher = 192; Foreground = 432 }
)
foreach ($density in $densities) {
    $dir = Join-Path $android $density.Dir
    New-PngIcon $density.Launcher "$dir\ic_launcher.png"
    New-PngIcon $density.Launcher "$dir\ic_launcher_round.png"
    New-PngIcon $density.Foreground "$dir\ic_launcher_foreground.png"
}
[System.IO.File]::WriteAllText(
    (Join-Path $android 'values\ic_launcher_background.xml'),
    "<?xml version=`"1.0`" encoding=`"utf-8`"?>`r`n<resources>`r`n  <color name=`"ic_launcher_background`">#050507</color>`r`n</resources>`r`n",
    $Utf8NoBom
)
Write-Host "  $(Join-Path $android 'values\ic_launcher_background.xml')"

Write-Host ""
Write-Host "==> Frontend asset (src/assets/logo.png)..."
New-PngIcon 512 (Join-Path $root 'src\assets\logo.png')

Write-Host ""
Write-Host "==> Browser extension icons (browser-extension/public/icons/)..."
$e = Join-Path $root 'browser-extension\public\icons'
New-PngIcon 16 "$e\icon-16.png"
New-PngIcon 32 "$e\icon-32.png"
New-PngIcon 48 "$e\icon-48.png"
New-PngIcon 128 "$e\icon-128.png"
New-PngIcon 512 "$e\icon.png"
New-PngIcon 512 "$e\logo.png"
New-IcoIcon "$e\icon.ico" @(16, 32, 48, 128)

Write-Host ""
Write-Host "==> Public web icons (public/)..."
$public = Join-Path $root 'public'
New-PngIcon 16 "$public\favicon-16x16.png"
New-PngIcon 32 "$public\favicon-32x32.png"
New-PngIcon 180 "$public\apple-touch-icon.png"
New-PngIcon 192 "$public\android-chrome-192x192.png"
New-PngIcon 512 "$public\android-chrome-512x512.png"
New-IcoIcon "$public\favicon.ico" @(16, 24, 32, 48, 64, 128, 256)
New-IcoIcon "$public\icon.ico" @(16, 24, 32, 48, 64, 128, 256)
Write-WebManifest "$public\site.webmanifest"

Write-Host ""
Write-Host "==> NSIS installer artwork (src-tauri/windows/)..."
$windows = Join-Path $root 'src-tauri\windows'
New-InstallerHeader "$windows\installer-header.bmp"
New-InstallerSidebar "$windows\installer-sidebar.bmp"

Write-Host ""
Write-Host "All icons and installer artwork generated successfully."

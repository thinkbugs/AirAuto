# SPDX-License-Identifier: AGPL-3.0-or-later
# Derives the Windows icon set from the AirAuto branding artwork in resources/branding.
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName System.Drawing
$iconRoot=Join-Path $projectRoot 'resources/icons'
$sourcePath=Join-Path $projectRoot 'resources/branding/airauto-source.png'
New-Item -ItemType Directory -Force $iconRoot | Out-Null
if(-not (Test-Path -LiteralPath $sourcePath)){throw "Missing branding source: $sourcePath"}
$sourceImage=[System.Drawing.Image]::FromFile($sourcePath)
$images=@()
foreach($size in @(16,24,32,48,64,128,256,512)){
 $bitmap=New-Object System.Drawing.Bitmap($size,$size)
 $drawing=[System.Drawing.Graphics]::FromImage($bitmap)
 $drawing.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
 $drawing.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
 $drawing.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality
 $drawing.Clear([System.Drawing.Color]::Transparent)
 $drawing.DrawImage($sourceImage,0,0,$size,$size)
 $stream=New-Object System.IO.MemoryStream;$bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png);$png=$stream.ToArray()
 if($size -ge 256){[IO.File]::WriteAllBytes((Join-Path $iconRoot "airauto-$size.png"),$png)}
 if($size -le 256){$images+=@{size=$size;bytes=$png}}
 $stream.Dispose();$drawing.Dispose();$bitmap.Dispose()
}
$sourceImage.Dispose()
$writer=New-Object System.IO.BinaryWriter([System.IO.File]::Create((Join-Path $iconRoot 'airauto.ico')))
$writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$images.Count)
$offset=6+16*$images.Count
foreach($entry in $images){$dimension=if($entry.size -eq 256){0}else{$entry.size};$writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([byte]0);$writer.Write([byte]0);$writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$entry.bytes.Length);$writer.Write([uint32]$offset);$offset+=$entry.bytes.Length}
foreach($entry in $images){$writer.Write([byte[]]$entry.bytes)}$writer.Close()
Copy-Item -LiteralPath (Join-Path $iconRoot 'airauto-256.png') -Destination (Join-Path $projectRoot 'src/ui/airauto.png') -Force

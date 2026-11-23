# Uninstall only AirAuto after a successful desktop installer export.
# Keep the user's AppData settings, credentials and pairing data.
$ErrorActionPreference='Stop'
$roots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$locations=@()
foreach($root in $roots){if(Test-Path -LiteralPath $root){foreach($key in Get-ChildItem -LiteralPath $root){$entry=Get-ItemProperty -LiteralPath $key.PSPath;if($entry.DisplayName -match '^AirAuto(\s|$)' -and $entry.InstallLocation){$locations+=$entry.InstallLocation}}}}
$locations+=Join-Path $env:ProgramFiles 'AirAuto'
$locations+=Join-Path $env:LOCALAPPDATA 'Programs/AirAuto'
foreach($location in ($locations | Select-Object -Unique)){
 $installedRoot=[IO.Path]::GetFullPath($location).TrimEnd('\')
 $uninstaller=Join-Path $installedRoot 'Uninstall AirAuto.exe'
 if(!(Test-Path -LiteralPath $uninstaller -PathType Leaf)){continue}
 $installedExe=Join-Path $installedRoot 'AirAuto.exe'
 Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'AirAuto.exe' -and $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($installedRoot+'\',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $airAutoProcessId=$_.ProcessId; try {Stop-Process -Id $airAutoProcessId -ErrorAction Stop} catch {if(Get-Process -Id $airAutoProcessId -ErrorAction SilentlyContinue){throw}} }
 $process=Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
 if($process.ExitCode -ne 0){throw ('AirAuto uninstaller failed, exit code: '+$process.ExitCode)}
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 while((Test-Path -LiteralPath $installedExe) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
 if(Test-Path -LiteralPath $installedExe){throw 'AirAuto uninstaller did not remove the installed executable. Administrator permission may be required.'}
 Write-Output 'Installed AirAuto removed. User data and the desktop installer are preserved.'
}

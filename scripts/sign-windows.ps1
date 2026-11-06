param(
  [Parameter(Mandatory = $true)]
  [string]$File
)

$thumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  Write-Error "WINDOWS_CERTIFICATE_THUMBPRINT is required for Windows signing."
  exit 1
}

$log = Join-Path $env:TEMP "bilipocket-sign.log"
Add-Content -Path $log -Value ("File={0} Thumb={1}" -f $File, $thumbprint)
$name = [IO.Path]::GetFileName($File).ToLowerInvariant()
if ($name -like "yt-dlp*.exe" -or $name -like "ffmpeg*.exe") {
  Write-Host "Skipping Authenticode signing for pinned sidecar $name so ENGINE_MANIFEST hashes stay valid."
  exit 0
}

$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $signtool) {
  $candidates = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if ($candidates) {
    $signtool = $candidates[0].FullName
  }
}
if (-not $signtool) {
  Write-Error "signtool.exe was not found."
  exit 1
}

$timestamp = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_TIMESTAMP_URL)) {
  "http://timestamp.digicert.com"
} else {
  $env:WINDOWS_TIMESTAMP_URL
}

& $signtool sign /fd SHA256 /sha1 $thumbprint /tr $timestamp /td SHA256 "$File"
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
Write-Host "Authenticode signed: $File"

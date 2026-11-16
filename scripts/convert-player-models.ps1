param(
  [string]$Blender = "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe",
  [string[]]$Models = @("mrfixit", "snoutx10k", "ogro2", "inky", "captaincannon")
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$arguments = @(
  "--background",
  "--python-exit-code", "1",
  "--python", (Join-Path $PSScriptRoot "convert-player-models.py"),
  "--",
  "--source", (Join-Path $root ".Sauerbraten\packages\models"),
  "--output", (Join-Path $root "public\assets\models\playermodels"),
  "--models"
) + $Models

& $Blender @arguments
if ($LASTEXITCODE -ne 0) { throw "Blender player-model conversion failed with exit code $LASTEXITCODE." }

$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$emcc = if ($env:EMSDK) { Join-Path $env:EMSDK "upstream/emscripten/emcc.exe" } else { "C:/dev/emsdk/upstream/emscripten/emcc.exe" }
$enet = Join-Path $repository ".Sauerbraten/src/enet"
$output = Join-Path $repository "src/network/enet/generated"
New-Item -ItemType Directory -Force $output | Out-Null

$sources = @(
    "callbacks.c", "compress.c", "host.c", "list.c", "packet.c", "peer.c", "protocol.c"
) | ForEach-Object { Join-Path $enet $_ }
$sources += Join-Path $repository "src/network/enet/platform_web.c"
$sources += Join-Path $repository "src/network/enet/bridge.c"

& $emcc @sources "-I$(Join-Path $enet 'include')" -O2 -sWASM=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web `
    -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sMALLOC=emmalloc "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']" `
    "-sEXPORTED_FUNCTIONS=['_malloc','_free']" -o (Join-Path $output "enet.js")
if ($LASTEXITCODE -ne 0) { throw "ENet WebAssembly build failed with exit code $LASTEXITCODE." }

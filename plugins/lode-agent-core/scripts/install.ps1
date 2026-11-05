$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot "distribution.mjs") install --source $pluginRoot @args
exit $LASTEXITCODE

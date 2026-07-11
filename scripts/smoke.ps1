$ErrorActionPreference = "Stop"
$python = Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Create .venv and install .[dev] first." }
& $python -m pytest
& $python -m cartograph.cli summary --graph (Join-Path $PSScriptRoot "..\examples\whisper-mcp.graph.json")
Write-Output "Cartograph smoke passed."

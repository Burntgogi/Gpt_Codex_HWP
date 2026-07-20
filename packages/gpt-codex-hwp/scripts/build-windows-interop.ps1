param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build\windows-interop')
)

$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $packageRoot 'src\workers\windows-job-interop.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$output = Join-Path $outputRoot 'gpt-codex-hwp-job.dll'

if (-not [System.IO.File]::Exists($source)) { throw 'Windows interop source is unavailable' }
if (-not [System.IO.File]::Exists($compiler)) { throw 'Compatible Windows C# compiler is unavailable' }
if ([System.IO.File]::Exists($output)) { throw 'Windows interop candidate output already exists' }
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

& $compiler /nologo /target:library /optimize+ /debug- "/out:$output" "$source"
if ($LASTEXITCODE -ne 0 -or -not [System.IO.File]::Exists($output)) {
  throw 'Windows interop candidate compilation failed'
}

$bytes = [System.IO.File]::ReadAllBytes($output)
$assembly = [System.Reflection.Assembly]::Load($bytes)
$interopType = $assembly.GetType('GptCodexHwpJob', $false, $false)
if ($null -eq $interopType -or -not $interopType.IsAbstract -or -not $interopType.IsSealed) {
  throw 'Windows interop candidate public type is invalid'
}
$requiredMethods = @(
  'AssignProcessToJobObject', 'CloseHandle', 'CreateJobObject', 'CreateToolhelp32Snapshot', 'ExitTimeHandle',
  'GetProcessId', 'GetProcessMemoryInfo', 'GetProcessTimes', 'HandleState',
  'NtQueryInformationProcess', 'OpenProcess', 'OpenSnapshotExact', 'Process32FirstW',
  'Process32NextW', 'QueryInformationJobObject', 'ReadCommandAsync', 'RecordFromHandle',
  'SetInformationJobObject', 'SnapshotProcesses', 'TerminateHandle', 'TerminateJobObject',
  'TerminateProcess', 'WaitForSingleObject', 'WorkingSetHandle'
)
$actualMethods = @($interopType.GetMethods([System.Reflection.BindingFlags]'Public,Static,DeclaredOnly') |
  ForEach-Object Name | Sort-Object -Unique)
if (($actualMethods -join ',') -ne (($requiredMethods | Sort-Object) -join ',')) {
  throw 'Windows interop candidate public API is invalid'
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $digest = [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
$compilerVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).FileVersion
[Console]::Out.WriteLine("WINDOWS_INTEROP_BUILD status=passed bytes=$($bytes.Length) sha256=$digest compiler=$compilerVersion")

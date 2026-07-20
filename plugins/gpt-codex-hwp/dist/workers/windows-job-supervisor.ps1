param(
  [Parameter(Mandatory = $true)]
  [int]$TargetPid,
  [switch]$ForceTracker,
  [switch]$HostedDiagnostic
)

$ErrorActionPreference = 'Stop'
function Write-HostedDiagnosticPhase([string]$Phase) {
  if (-not $HostedDiagnostic) { return }
  [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB PHASE $Phase")
  [Console]::Out.Flush()
}

Write-HostedDiagnosticPhase 'script-entry'
$assemblyPath = Join-Path $PSScriptRoot 'gpt-codex-hwp-job.dll'
Write-HostedDiagnosticPhase 'assembly-verify'
try {
  $assemblyBytes = [System.IO.File]::ReadAllBytes($assemblyPath)
} catch {
  throw 'Windows Job interop assembly unavailable'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $assemblySha256 = [System.BitConverter]::ToString($sha256.ComputeHash($assemblyBytes)).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
if ($assemblySha256 -ne '07459231d881addf577628ab42a77d43749a3ab12412991a8dbccc3cbd8f6656') {
  throw 'Windows Job interop assembly integrity check failed'
}
Write-HostedDiagnosticPhase 'assembly-load'
[void][System.Reflection.Assembly]::Load($assemblyBytes)
$retained = @{}
$retainedByPid = @{}

function Get-IdentityKey($record) {
  return "$($record.Id)`:$($record.CreationTime)"
}

function Find-RetainedParent($record) {
  if (-not $retainedByPid.ContainsKey($record.ParentId)) { return $null }
  $matches = @()
  foreach ($entry in @($retainedByPid[$record.ParentId])) {
    if ($entry.CreationTime -gt $record.CreationTime) { continue }
    [long]$exitTime = [GptCodexHwpJob]::ExitTimeHandle($entry.Handle)
    if ($exitTime -ge $record.CreationTime) { $matches += $entry }
  }
  if ($matches.Count -gt 1) { throw 'ambiguous retained parent lifetime' }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Update-TrackedIdentities {
  $records = @([GptCodexHwpJob]::SnapshotProcesses())
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($hint in $records) {
      if (-not $retainedByPid.ContainsKey($hint.ParentId)) { continue }
      $record = [GptCodexHwpJob]::OpenSnapshotExact($hint.Id, $hint.ParentId)
      if ($null -eq $record) { continue }
      $adopted = $false
      try {
        $key = Get-IdentityKey $record
        if ($retained.ContainsKey($key)) { continue }
        $parent = Find-RetainedParent $record
        if ($null -eq $parent -or $record.CreationTime -lt $rootCreation) { continue }
        if ($retained.Count -ge 4096) { throw 'retained identity limit exceeded' }
      $entry = [PSCustomObject]@{
        Id = $record.Id
        ParentId = $record.ParentId
        CreationTime = $record.CreationTime
        Handle = $record.Handle
        ParentKey = "$($parent.Id)`:$($parent.CreationTime)"
        Depth = [int]$parent.Depth + 1
      }
      $retained[$key] = $entry
      if ($retainedByPid.ContainsKey($record.Id)) {
        $retainedByPid[$record.Id] = @($retainedByPid[$record.Id]) + @($entry)
      } else {
        $retainedByPid[$record.Id] = @($entry)
      }
        $adopted = $true
      $changed = $true
      } finally {
        if (-not $adopted) { [void][GptCodexHwpJob]::CloseHandle($record.Handle) }
      }
    }
  }
  return @($records)
}

function Get-LiveTracked {
  $live = @()
  foreach ($entry in @($retained.Values)) {
    if ([GptCodexHwpJob]::HandleState($entry.Handle) -eq 1) { $live += $entry }
  }
  return @($live | Sort-Object Depth, CreationTime)
}

function Measure-TrackedWorkingSet($records) {
  [long]$total = 0
  foreach ($entry in @(Get-LiveTracked)) {
    [long]$workingSet = [GptCodexHwpJob]::WorkingSetHandle($entry.Handle)
    if ($workingSet -lt 0) { continue }
    if ($workingSet -lt 0 -or $total -gt ([long]::MaxValue - $workingSet)) {
      throw 'working set total overflow'
    }
    $total += $workingSet
  }
  return $total
}

$maxDiscoveryPollMs = 0
function Invoke-TrackedPoll {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $records = @(Update-TrackedIdentities)
  $watch.Stop()
  $elapsed = [int][Math]::Ceiling($watch.Elapsed.TotalMilliseconds)
  return @($records)
}

function Stop-TrackedTree {
  $script:stopFailure = 'none'
  $quiescentScans = 0
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    $discoveryComplete = $false
    try {
      $records = @(Invoke-TrackedPoll)
      $discoveryComplete = $true
      [long]$terminationRss = Measure-TrackedWorkingSet $records
      if ($terminationRss -gt $script:peakRss) { $script:peakRss = $terminationRss }
    } catch {
      $script:stopFailure = 'discovery-or-rss-unavailable'
      [void](Invoke-RetainedTerminationPass)
      if (-not $discoveryComplete) { return $false }
      return $false
    }
    $terminationPass = Invoke-RetainedTerminationPass
    if (-not $terminationPass.Complete) {
      $script:stopFailure = 'retained-handle-unavailable'
      return $false
    }
    if ($terminationPass.AllGone) {
      $quiescentScans += 1
      if ($quiescentScans -ge 2) { return $true }
      Start-Sleep -Milliseconds 20
      continue
    }
    $quiescentScans = 0
    Start-Sleep -Milliseconds 20
  }
  $script:stopFailure = 'scan-exhausted'
  return $false
}

function Invoke-RetainedTerminationPass {
  $complete = $true
  $allGone = $true
  $entries = @($retained.Values | Sort-Object `
    @{ Expression = 'Depth'; Descending = $true }, `
    @{ Expression = 'CreationTime'; Descending = $true })
  foreach ($entry in $entries) {
    try {
      if ([GptCodexHwpJob]::HandleState($entry.Handle) -eq 0) { continue }
      $allGone = $false
      if (-not [GptCodexHwpJob]::TerminateHandle($entry.Handle)) { $complete = $false }
    } catch {
      $complete = $false
      $allGone = $false
    }
  }
  return [PSCustomObject]@{ Complete = $complete; AllGone = $allGone }
}

function Stop-RetainedHandles {
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    $terminationPass = Invoke-RetainedTerminationPass
    if ($terminationPass.Complete -and $terminationPass.AllGone) { return $true }
    Start-Sleep -Milliseconds 20
  }
  return $false
}

$job = [IntPtr]::Zero
$process = [IntPtr]::Zero
$mode = 2
$verifiedGone = $false
$failure = $null
$failureStage = 'startup'
try {
  Write-HostedDiagnosticPhase 'job-create'
  $job = [GptCodexHwpJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
  $limits = New-Object GptCodexHwpJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $limits.BasicLimitInformation.LimitFlags = 0x00002000
  $limitSize = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  if (-not [GptCodexHwpJob]::SetInformationJobObject($job, 9, [ref]$limits, $limitSize)) {
    throw 'SetInformationJobObject failed'
  }
  Write-HostedDiagnosticPhase 'target-open'
  $process = [GptCodexHwpJob]::OpenProcess(0x00101101, $false, $TargetPid)
  if ($process -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }
  try {
    Write-HostedDiagnosticPhase 'target-identity'
    $rootRecord = [GptCodexHwpJob]::RecordFromHandle($process, $TargetPid)
    [long]$rootCreation = $rootRecord.CreationTime
    $rootKey = "$TargetPid`:$rootCreation"
    $retained[$rootKey] = [PSCustomObject]@{
      Id = $TargetPid
      ParentId = $rootRecord.ParentId
      CreationTime = $rootCreation
      Handle = $process
      ParentKey = $null
      Depth = 0
    }
    $retainedByPid[$TargetPid] = @($retained[$rootKey])
  } catch {
    [void][GptCodexHwpJob]::CloseHandle($process)
    $process = [IntPtr]::Zero
    throw
  }
  Write-HostedDiagnosticPhase 'job-bind'
  if (-not $ForceTracker -and [GptCodexHwpJob]::AssignProcessToJobObject($job, $process)) { $mode = 1 }
  Write-HostedDiagnosticPhase 'snapshot'
  $baselineRecords = @(Invoke-TrackedPoll)
  $failureStage = 'baseline-rss'
  Write-HostedDiagnosticPhase 'baseline-rss'
  [long]$baselineRss = Measure-TrackedWorkingSet $baselineRecords
  if ($baselineRss -le 0) { throw 'baseline working set unavailable' }
  [long]$script:peakRss = $baselineRss
  Write-HostedDiagnosticPhase 'ready-write'
  [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB READY $TargetPid $mode $rootCreation")
  [Console]::Out.Flush()
  $commandTask = [GptCodexHwpJob]::ReadCommandAsync()
  $failureStage = 'sampling'
  while (-not $commandTask.IsCompleted) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $sampleRecords = @(Update-TrackedIdentities)
    [long]$sampleRss = Measure-TrackedWorkingSet $sampleRecords
    if ($sampleRss -gt $script:peakRss) { $script:peakRss = $sampleRss }
    $watch.Stop()
    $elapsed = [int][Math]::Ceiling($watch.Elapsed.TotalMilliseconds)
    if ($elapsed -gt $maxDiscoveryPollMs) { $maxDiscoveryPollMs = $elapsed }
    Start-Sleep -Milliseconds 20
  }
  $command = $commandTask.GetAwaiter().GetResult()
  if ($command -ne 'TERMINATE') { throw 'invalid supervisor command' }
  $failureStage = 'termination'
  if ($mode -eq 1 -and -not [GptCodexHwpJob]::TerminateJobObject($job, 137)) {
    throw 'TerminateJobObject failed'
  }
  if (-not (Stop-TrackedTree)) {
    $failureStage = "termination-$script:stopFailure"
    throw 'tracked tree did not reach zero'
  }
  if ($mode -eq 1) {
    $accounting = New-Object GptCodexHwpJob+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
    if (-not [GptCodexHwpJob]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingSize, [IntPtr]::Zero)) { throw 'QueryInformationJobObject failed' }
    if ($accounting.ActiveProcesses -ne 0) { throw 'job active process count did not reach zero' }
  }
  if ($ForceTracker) {
    [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB TRACKER $maxDiscoveryPollMs $($retained.Count)")
    [Console]::Out.Flush()
  }
  $failureStage = 'rss-receipt'
  [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB RSS $baselineRss $script:peakRss")
  [Console]::Out.Flush()
  $verifiedGone = $true
} catch {
  $failure = $_
  $reason = $_.Exception.Message
  if ($null -ne $_.Exception.InnerException) { $reason = $_.Exception.InnerException.Message }
  $safeReason = ($reason -replace '[^A-Za-z0-9_-]', '_')
  if ($safeReason.Length -gt 48) { $safeReason = $safeReason.Substring(0, 48) }
  [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB ERROR $failureStage $safeReason")
  [Console]::Out.Flush()
} finally {
  try {
    if ($job -ne [IntPtr]::Zero) {
      [void][GptCodexHwpJob]::TerminateJobObject($job, 137)
    }
    if (-not (Stop-RetainedHandles)) { throw 'final retained tree did not reach zero' }
  } catch {
    if ($null -eq $failure) { $failure = $_ }
  } finally {
    foreach ($entry in @($retained.Values)) {
      if ($entry.Handle -ne [IntPtr]::Zero -and -not [GptCodexHwpJob]::CloseHandle($entry.Handle)) {
        if ($null -eq $failure) { $failure = 'process handle close failed' }
      }
    }
    $process = [IntPtr]::Zero
    if ($job -ne [IntPtr]::Zero -and -not [GptCodexHwpJob]::CloseHandle($job)) {
      if ($null -eq $failure) { $failure = 'job handle close failed' }
    }
  }
}
if ($null -ne $failure) { throw $failure }
if (-not $verifiedGone) { throw 'tracked tree verification unavailable' }
[Console]::Out.WriteLine("GPT_CODEX_HWP_JOB GONE 0 $mode")
[Console]::Out.Flush()

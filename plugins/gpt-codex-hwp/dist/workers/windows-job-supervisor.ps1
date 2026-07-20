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
$source = @'
using System;
using System.Runtime.InteropServices;

public static class GptCodexHwpJob {
  public sealed class ProcessRecord {
    public int Id;
    public int ParentId;
    public long CreationTime;
    public IntPtr Handle;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_MEMORY_COUNTERS {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize;
    public UIntPtr QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
    public UIntPtr QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage;
    public UIntPtr PagefileUsage, PeakPagefileUsage;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public int ExitStatus;
    public IntPtr PebBaseAddress;
    public UIntPtr AffinityMask;
    public int BasePriority;
    public UIntPtr UniqueProcessId, InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint GetProcessId(IntPtr process);
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetProcessMemoryInfo(IntPtr process, out PROCESS_MEMORY_COUNTERS counters, uint length);
  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out PROCESS_BASIC_INFORMATION info, uint length, out uint returnedLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

  public static ProcessRecord RecordFromHandle(IntPtr process, int expectedPid) {
    long creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    PROCESS_BASIC_INFORMATION info;
    uint returnedLength;
    uint expectedLength = (uint)Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION));
    int status = NtQueryInformationProcess(process, 0, out info, expectedLength, out returnedLength);
    if (status < 0 || returnedLength < expectedLength) throw new InvalidOperationException("NtQueryInformationProcess failed");
    uint handlePid = GetProcessId(process);
    uint pbiPid = checked((uint)info.UniqueProcessId.ToUInt64());
    if (handlePid != expectedPid || pbiPid != expectedPid) throw new InvalidOperationException("process handle PID mismatch");
    return new ProcessRecord {
      Id = expectedPid,
      ParentId = checked((int)info.InheritedFromUniqueProcessId.ToUInt64()),
      CreationTime = creation,
      Handle = process
    };
  }

  public static ProcessRecord OpenSnapshotExact(int pid, int expectedParentId) {
    IntPtr process = OpenProcess(0x00101001, false, pid);
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 87) return null;
      throw new System.ComponentModel.Win32Exception(error);
    }
    try {
      ProcessRecord record = RecordFromHandle(process, pid);
      if (record.ParentId != expectedParentId) { CloseHandle(process); return null; }
      return record;
    } catch { CloseHandle(process); throw; }
  }

  public static int HandleState(IntPtr process) {
    uint state = WaitForSingleObject(process, 0);
    if (state == 0) return 0;
    if (state == 258) return 1;
    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }

  public static long WorkingSetHandle(IntPtr process) {
    if (HandleState(process) == 0) return -1;
    PROCESS_MEMORY_COUNTERS counters = new PROCESS_MEMORY_COUNTERS();
    counters.cb = (uint)Marshal.SizeOf(counters);
    if (!GetProcessMemoryInfo(process, out counters, counters.cb)) {
      if (HandleState(process) == 0) return -1;
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    ulong value = counters.WorkingSetSize.ToUInt64();
    if (value > long.MaxValue) throw new OverflowException("working set exceeds Int64");
    return (long)value;
  }

  public static bool TerminateHandle(IntPtr process) {
    if (HandleState(process) == 0) return true;
    int lastError = 0;
    for (int attempt = 0; attempt < 10; attempt++) {
      if (TerminateProcess(process, 137)) return true;
      lastError = Marshal.GetLastWin32Error();
      if (HandleState(process) == 0) return true;
      System.Threading.Thread.Sleep(5);
    }
    throw new InvalidOperationException("TerminateProcess_" + lastError);
  }

  public static long ExitTimeHandle(IntPtr process) {
    if (HandleState(process) != 0) return long.MaxValue;
    long creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return exit;
  }

  public static ProcessRecord[] SnapshotProcesses() {
    IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("CreateToolhelp32Snapshot failed");
    var records = new System.Collections.Generic.List<ProcessRecord>();
    try {
      PROCESSENTRY32 entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(entry);
      if (!Process32FirstW(snapshot, ref entry)) throw new InvalidOperationException("Process32First failed");
      do {
        int pid = unchecked((int)entry.th32ProcessID);
        records.Add(new ProcessRecord {
          Id = pid,
          ParentId = unchecked((int)entry.th32ParentProcessID),
          CreationTime = 0,
          Handle = IntPtr.Zero
        });
        entry.dwSize = (uint)Marshal.SizeOf(entry);
      } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    return records.ToArray();
  }

  public static System.Threading.Tasks.Task<string> ReadCommandAsync() {
    return System.Threading.Tasks.Task.Run(() => Console.In.ReadLine());
  }

}
'@

Write-HostedDiagnosticPhase 'add-type'
Add-Type -TypeDefinition $source -Language CSharp
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

param(
  [Parameter(Mandatory = $true)]
  [int]$TargetPid,
  [switch]$ForceTracker
)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class GptCodexHwpJob {
  public sealed class ProcessRecord {
    public int Id;
    public int ParentId;
    public long CreationTime;
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
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

  public static long CreationTime(int pid) {
    IntPtr process = OpenProcess(0x00001000, false, pid);
    if (process == IntPtr.Zero) return 0;
    try {
      long creation, exit, kernel, user;
      return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation : 0;
    } finally { CloseHandle(process); }
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
        records.Add(new ProcessRecord { Id = pid, ParentId = unchecked((int)entry.th32ParentProcessID), CreationTime = 0 });
        entry.dwSize = (uint)Marshal.SizeOf(entry);
      } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    return records.ToArray();
  }

  public static System.Threading.Tasks.Task<string> ReadCommandAsync() {
    return System.Threading.Tasks.Task.Run(() => Console.In.ReadLine());
  }

  public static bool TerminateExact(int pid, long creationTime) {
    IntPtr process = OpenProcess(0x00001001, false, pid);
    if (process == IntPtr.Zero) {
      long current = CreationTime(pid);
      return current == 0 || current != creationTime;
    }
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return false;
      if (creation != creationTime) return true;
      return TerminateProcess(process, 137);
    } finally { CloseHandle(process); }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$rootCreation = [GptCodexHwpJob]::CreationTime($TargetPid)
if ($rootCreation -le 0) { throw 'root process creation time unavailable' }

$retained = @{}
$rootKey = "$TargetPid`:$rootCreation"
$retained[$rootKey] = [PSCustomObject]@{
  Id = $TargetPid
  ParentId = 0
  CreationTime = $rootCreation
  ParentKey = $null
  Depth = 0
}
$retainedByPid = @{}
$retainedByPid[$TargetPid] = @($retained[$rootKey])

function Get-IdentityKey($record) {
  return "$($record.Id)`:$($record.CreationTime)"
}

function Resolve-CreationTime($record) {
  if ($record.CreationTime -le 0) {
    $record.CreationTime = [GptCodexHwpJob]::CreationTime($record.Id)
  }
  return [long]$record.CreationTime
}

function Find-RetainedParent($record, $liveByPid) {
  if (-not $retainedByPid.ContainsKey($record.ParentId)) { return $null }
  $numericCandidates = @($retainedByPid[$record.ParentId])
  $recordCreation = Resolve-CreationTime $record
  if ($recordCreation -le 0) { return $null }
  if ($liveByPid.ContainsKey($record.ParentId)) {
    $liveParent = $liveByPid[$record.ParentId]
    [void](Resolve-CreationTime $liveParent)
    $liveKey = Get-IdentityKey $liveParent
    if ($retained.ContainsKey($liveKey)) { return $retained[$liveKey] }
    if ($recordCreation -ge $liveParent.CreationTime) { return $null }
  }
  $candidate = $null
  foreach ($entry in $numericCandidates) {
    if ($entry.CreationTime -gt $recordCreation) { continue }
    if ($null -eq $candidate -or $entry.CreationTime -gt $candidate.CreationTime) {
      $candidate = $entry
    }
  }
  return $candidate
}

function Update-TrackedIdentities {
  $records = @([GptCodexHwpJob]::SnapshotProcesses())
  $liveByPid = @{}
  foreach ($record in $records) {
    $liveByPid[$record.Id] = $record
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($record in $records) {
      if ($retainedByPid.ContainsKey($record.Id)) {
        [void](Resolve-CreationTime $record)
        if ($record.CreationTime -gt 0 -and $retained.ContainsKey((Get-IdentityKey $record))) {
          continue
        }
      }
      $parent = Find-RetainedParent $record $liveByPid
      if ($null -eq $parent) { continue }
      if ($record.CreationTime -lt $rootCreation) { continue }
      $key = Get-IdentityKey $record
      if ($retained.ContainsKey($key)) { continue }
      $entry = [PSCustomObject]@{
        Id = $record.Id
        ParentId = $record.ParentId
        CreationTime = $record.CreationTime
        ParentKey = "$($parent.Id)`:$($parent.CreationTime)"
        Depth = [int]$parent.Depth + 1
      }
      $retained[$key] = $entry
      if ($retainedByPid.ContainsKey($record.Id)) {
        $retainedByPid[$record.Id] = @($retainedByPid[$record.Id]) + @($entry)
      } else {
        $retainedByPid[$record.Id] = @($entry)
      }
      $changed = $true
    }
  }
  return @($records)
}

function Get-LiveTracked($records) {
  $live = @()
  foreach ($record in $records) {
    if (-not $retainedByPid.ContainsKey($record.Id)) { continue }
    [void](Resolve-CreationTime $record)
    $key = Get-IdentityKey $record
    if ($retained.ContainsKey($key)) {
      $live += $retained[$key]
    }
  }
  return @($live | Sort-Object Depth, CreationTime)
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
  $quiescentScans = 0
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    $records = @(Invoke-TrackedPoll)
    $live = @(Get-LiveTracked $records)
    if ($live.Count -eq 0) {
      $quiescentScans += 1
      if ($quiescentScans -ge 2) { return $true }
      Start-Sleep -Milliseconds 20
      continue
    }
    $quiescentScans = 0
    foreach ($entry in $live) {
      if (-not [GptCodexHwpJob]::TerminateExact($entry.Id, $entry.CreationTime)) {
        return $false
      }
    }
    Start-Sleep -Milliseconds 20
  }
  return $false
}

$job = [IntPtr]::Zero
$process = [IntPtr]::Zero
$mode = 2
try {
  $job = [GptCodexHwpJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
  $limits = New-Object GptCodexHwpJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $limits.BasicLimitInformation.LimitFlags = 0x00002000
  $limitSize = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  if (-not [GptCodexHwpJob]::SetInformationJobObject($job, 9, [ref]$limits, $limitSize)) {
    throw 'SetInformationJobObject failed'
  }
  $process = [GptCodexHwpJob]::OpenProcess(0x00001101, $false, $TargetPid)
  if ($process -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }
  if (-not $ForceTracker -and [GptCodexHwpJob]::AssignProcessToJobObject($job, $process)) { $mode = 1 }
  [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB READY $TargetPid $mode $rootCreation")
  [Console]::Out.Flush()
  $commandTask = [GptCodexHwpJob]::ReadCommandAsync()
  while (-not $commandTask.IsCompleted) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    [void](Update-TrackedIdentities)
    $watch.Stop()
    $elapsed = [int][Math]::Ceiling($watch.Elapsed.TotalMilliseconds)
    if ($elapsed -gt $maxDiscoveryPollMs) { $maxDiscoveryPollMs = $elapsed }
    Start-Sleep -Milliseconds 20
  }
  $command = $commandTask.GetAwaiter().GetResult()
  if ($command -ne 'TERMINATE') { throw 'invalid supervisor command' }
  if ($mode -eq 1) { [void][GptCodexHwpJob]::TerminateJobObject($job, 137) }
  if (-not (Stop-TrackedTree)) { throw 'tracked tree did not reach zero' }
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
  [Console]::Out.WriteLine("GPT_CODEX_HWP_JOB GONE 0 $mode")
  [Console]::Out.Flush()
} finally {
  if ($job -ne [IntPtr]::Zero) {
    [void][GptCodexHwpJob]::TerminateJobObject($job, 137)
  }
  [void](Stop-TrackedTree)
  if ($process -ne [IntPtr]::Zero) { [void][GptCodexHwpJob]::CloseHandle($process) }
  if ($job -ne [IntPtr]::Zero) { [void][GptCodexHwpJob]::CloseHandle($job) }
}

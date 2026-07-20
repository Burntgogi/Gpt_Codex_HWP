using System;
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Gpt_Codex_HWP Windows Job Interop")]
[assembly: AssemblyProduct("Gpt_Codex_HWP")]
[assembly: AssemblyCompany("Gpt_Codex_HWP contributors")]
[assembly: AssemblyCopyright("Copyright 2026 Gpt_Codex_HWP contributors")]
[assembly: AssemblyVersion("1.0.0.0")]

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

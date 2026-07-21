import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const ALLOWED_RESULTS = new Set<WindowsOwnerOnlyAclResult>([
  "OK",
  "process",
  "exception",
  "unprotected",
  "extra-rule",
  "missing-required",
  "invalid-rule",
  "invalid-output",
]);

export type WindowsOwnerOnlyAclKind = "directory" | "file";
export type WindowsOwnerOnlyAclResult =
  | "OK"
  | "process"
  | "exception"
  | "unprotected"
  | "extra-rule"
  | "missing-required"
  | "invalid-rule"
  | "invalid-output";

type WindowsAclRunner = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  }>,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export async function applyWindowsOwnerOnlyAcl(
  path: string,
  kind: WindowsOwnerOnlyAclKind,
  options: Readonly<{
    platform?: NodeJS.Platform;
    sourceEnvironment?: NodeJS.ProcessEnv;
    run?: WindowsAclRunner;
  }> = {},
): Promise<WindowsOwnerOnlyAclResult> {
  const platform = options.platform ?? process.platform;
  const sourceEnvironment = options.sourceEnvironment ?? process.env;
  if (platform !== "win32" || typeof path !== "string" || path.length === 0) {
    return "invalid-output";
  }
  const run = options.run ?? runWindowsAclPowerShell;
  let result: Readonly<{ stdout: string; stderr: string }>;
  try {
    const command = resolveWindowsAclPowerShell(platform, sourceEnvironment.SystemRoot);
    result = await run(
      command,
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_OWNER_ONLY_ACL_SCRIPT],
      {
        encoding: "utf8",
        env: createWindowsAclHelperEnvironment(path, kind, sourceEnvironment),
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
  } catch {
    return "process";
  }
  if (result.stderr !== "" || !ALLOWED_RESULTS.has(result.stdout as WindowsOwnerOnlyAclResult)) {
    return "invalid-output";
  }
  return result.stdout as WindowsOwnerOnlyAclResult;
}

export function createWindowsAclHelperEnvironment(
  path: string,
  kind: WindowsOwnerOnlyAclKind,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    GPT_CODEX_HWP_ACL_PATH: path,
    GPT_CODEX_HWP_ACL_KIND: kind,
  };
  for (const key of ["SystemRoot", "WINDIR", "LANG", "LC_ALL"] as const) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function resolveWindowsAclPowerShell(
  platform: NodeJS.Platform = process.platform,
  systemRoot?: string,
): string {
  if (platform !== "win32") return "powershell.exe";
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw new Error("absolute SystemRoot is required");
  }
  return win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runWindowsAclPowerShell(
  command: string,
  args: readonly string[],
  options: Readonly<{
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  }>,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const result = await execFileAsync(command, [...args], options);
  return { stdout: result.stdout, stderr: result.stderr };
}

const WINDOWS_OWNER_ONLY_ACL_SCRIPT = [
  "try{",
  "$kind=$env:GPT_CODEX_HWP_ACL_KIND",
  "$item=if($kind -eq 'directory'){[System.IO.DirectoryInfo]::new($env:GPT_CODEX_HWP_ACL_PATH)}elseif($kind -eq 'file'){[System.IO.FileInfo]::new($env:GPT_CODEX_HWP_ACL_PATH)}else{[Console]::Out.Write('invalid-output');return}",
  "$acl=if($kind -eq 'directory'){[System.Security.AccessControl.DirectorySecurity]::new()}else{[System.Security.AccessControl.FileSecurity]::new()}",
  "[void]$acl.SetAccessRuleProtection($true,$false)",
  "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  `$system=[System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_SYSTEM_SID}')`,
  "$rights=[System.Security.AccessControl.FileSystemRights]::FullControl",
  "$allow=[System.Security.AccessControl.AccessControlType]::Allow",
  "$inheritance=if($kind -eq 'directory'){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[System.Security.AccessControl.InheritanceFlags]::None}",
  "$propagation=[System.Security.AccessControl.PropagationFlags]::None",
  "[void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current,$rights,$inheritance,$propagation,$allow))",
  "[void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system,$rights,$inheritance,$propagation,$allow))",
  "[void]$item.SetAccessControl($acl)",
  "$verified=$item.GetAccessControl()",
  "if(-not $verified.AreAccessRulesProtected){[Console]::Out.Write('unprotected');return}",
  "$rules=$verified.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
  "if($rules.Count -ne 2){[Console]::Out.Write('extra-rule');return}",
  "$currentCount=0",
  "$systemCount=0",
  "$invalid=$false",
  "foreach($rule in $rules){$sid=$rule.IdentityReference.Value;if($sid -eq $current.Value){$currentCount+=1}elseif($sid -eq $system.Value){$systemCount+=1}else{[Console]::Out.Write('extra-rule');return};if($rule.IsInherited -or $rule.AccessControlType -ne $allow -or (($rule.FileSystemRights -band $rights) -ne $rights) -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne $propagation){$invalid=$true}}",
  "if($invalid){[Console]::Out.Write('invalid-rule');return}",
  "if($currentCount -ne 1 -or $systemCount -ne 1){[Console]::Out.Write('missing-required');return}",
  "[Console]::Out.Write('OK')",
  "}catch{[Console]::Out.Write('exception')}",
].join(";");

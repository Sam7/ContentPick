param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'The restricted-token smoke launcher requires 64-bit PowerShell.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_EVENT_NAME -ne 'push') {
    throw 'This reduced-token launcher is restricted to GitHub-hosted Windows push runs.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$smokeScript = (Resolve-Path (Join-Path $PSScriptRoot 'test-installed.ps1')).Path
$powershell = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { throw "PowerShell executable not found: $powershell" }
$resultsDir = Join-Path $repoRoot 'test-results'
New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null
$logPath = Join-Path $resultsDir 'installed-smoke-restricted.log'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ContextPickRestrictedLauncher {
    [StructLayout(LayoutKind.Sequential)] public struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct StartupInfo {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] public struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] public struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] public struct SecurityAttributes { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] public struct LuidAndAttributes { public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] public struct TokenPrivileges { public uint PrivilegeCount; public LuidAndAttributes Privileges; }

    const uint TOKEN_ASSIGN_PRIMARY=0x0001, TOKEN_DUPLICATE=0x0002, TOKEN_QUERY=0x0008, TOKEN_ADJUST_PRIVILEGES=0x0020, TOKEN_ADJUST_DEFAULT=0x0080;
    const uint DISABLE_MAX_PRIVILEGE=0x1, SE_GROUP_INTEGRITY=0x20, SE_PRIVILEGE_ENABLED=0x2;
    const int TokenType=8, TokenElevation=20, TokenIntegrityLevel=25;
    const uint STARTF_USESTDHANDLES=0x100, CREATE_UNICODE_ENVIRONMENT=0x400, EXTENDED_STARTUPINFO_PRESENT=0x80000, WAIT_OBJECT_0=0, INFINITE=0xffffffff;
    const uint GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000, FILE_SHARE_READ=1, FILE_SHARE_WRITE=2, OPEN_EXISTING=3, CREATE_ALWAYS=2, FILE_ATTRIBUTE_NORMAL=0x80;

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr sidsToDisable, uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictedSidCount, IntPtr restrictedSids, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertStringSidToSid(string sid, out IntPtr result);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, int bufferLength, IntPtr previous, IntPtr returned);
    [DllImport("advapi32.dll", SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll", EntryPoint="CreateProcessAsUserW", ExactSpelling=true, SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, IntPtr startup, out ProcessInformation processInfo);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    static Exception Win32(string action) { return new Win32Exception(Marshal.GetLastWin32Error(), action); }
    static IntPtr Sid(string value) { IntPtr p; if (!ConvertStringSidToSid(value, out p)) throw Win32("ConvertStringSidToSid("+value+")"); return p; }
    static void SetMediumIntegrity(IntPtr token) {
        IntPtr sid = Sid("S-1-16-8192"), block = IntPtr.Zero;
        try {
            SidAndAttributes label = new SidAndAttributes { Sid=sid, Attributes=SE_GROUP_INTEGRITY };
            int labelSize=Marshal.SizeOf(typeof(SidAndAttributes));
            uint sidSize=GetLengthSid(sid);
            if (sidSize==0) throw Win32("GetLengthSid(medium integrity SID)");
            block = Marshal.AllocHGlobal(labelSize+(int)sidSize);
            Marshal.StructureToPtr(label, block, false);
            if (!SetTokenInformation(token, TokenIntegrityLevel, block, labelSize+(int)sidSize)) throw Win32("SetTokenInformation(TokenIntegrityLevel)");
        } finally { if (block != IntPtr.Zero) Marshal.FreeHGlobal(block); if (sid != IntPtr.Zero) LocalFree(sid); }
    }
    static TokenPrivileges EnableRequiredPrivilege(IntPtr parent, string name) {
        Luid luid; if (!LookupPrivilegeValue(null, name, out luid)) throw Win32("LookupPrivilegeValue("+name+")");
        TokenPrivileges state = new TokenPrivileges { PrivilegeCount=1, Privileges=new LuidAndAttributes { Luid=luid, Attributes=SE_PRIVILEGE_ENABLED } };
        IntPtr prior=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TokenPrivileges))), size=Marshal.AllocHGlobal(4);
        try {
            Marshal.WriteInt32(size, 0);
            Marshal.SetLastPInvokeError(0);
            if (!AdjustTokenPrivileges(parent, false, ref state, Marshal.SizeOf(typeof(TokenPrivileges)), prior, size) || Marshal.GetLastWin32Error()==1300) throw Win32("Enable required privilege "+name);
            return (TokenPrivileges)Marshal.PtrToStructure(prior, typeof(TokenPrivileges));
        } finally { Marshal.FreeHGlobal(prior); Marshal.FreeHGlobal(size); }
    }
    static bool TryEnablePrivilege(IntPtr parent, string name, out TokenPrivileges previous) {
        Luid luid; if (!LookupPrivilegeValue(null, name, out luid)) throw Win32("LookupPrivilegeValue("+name+")");
        TokenPrivileges state = new TokenPrivileges { PrivilegeCount=1, Privileges=new LuidAndAttributes { Luid=luid, Attributes=SE_PRIVILEGE_ENABLED } };
        IntPtr prior=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TokenPrivileges))), size=Marshal.AllocHGlobal(4);
        try {
            Marshal.WriteInt32(size, 0);
            Marshal.SetLastPInvokeError(0);
            bool adjusted=AdjustTokenPrivileges(parent, false, ref state, Marshal.SizeOf(typeof(TokenPrivileges)), prior, size);
            int error=Marshal.GetLastWin32Error();
            if (error==1300) { previous=default(TokenPrivileges); return false; }
            if (!adjusted) throw new Win32Exception(error, "Enable optional privilege "+name);
            previous=(TokenPrivileges)Marshal.PtrToStructure(prior, typeof(TokenPrivileges));
            return true;
        } finally { Marshal.FreeHGlobal(prior); Marshal.FreeHGlobal(size); }
    }
    static Exception RestorePrivileges(IntPtr parent, ref bool assignEnabled, ref TokenPrivileges priorAssign, ref bool quotaEnabled, ref TokenPrivileges priorQuota) {
        Exception failure=null;
        if (assignEnabled) {
            Marshal.SetLastPInvokeError(0);
            bool restored=AdjustTokenPrivileges(parent, false, ref priorAssign, 0, IntPtr.Zero, IntPtr.Zero);
            int error=Marshal.GetLastWin32Error(); assignEnabled=false;
            if ((!restored || error==1300) && failure==null) failure=new Win32Exception(error, "Restore SeAssignPrimaryTokenPrivilege state");
        }
        if (quotaEnabled) {
            Marshal.SetLastPInvokeError(0);
            bool restored=AdjustTokenPrivileges(parent, false, ref priorQuota, 0, IntPtr.Zero, IntPtr.Zero);
            int error=Marshal.GetLastWin32Error(); quotaEnabled=false;
            if ((!restored || error==1300) && failure==null) failure=new Win32Exception(error, "Restore SeIncreaseQuotaPrivilege state");
        }
        return failure;
    }
    static int GetTokenType(IntPtr token) {
        IntPtr b=Marshal.AllocHGlobal(4); try { int needed; if (!GetTokenInformation(token, TokenType, b, 4, out needed)) throw Win32("GetTokenInformation(TokenType)"); return Marshal.ReadInt32(b); } finally { Marshal.FreeHGlobal(b); }
    }
    static bool IsElevated(IntPtr token) {
        IntPtr b=Marshal.AllocHGlobal(4); try { int needed; if (!GetTokenInformation(token, TokenElevation, b, 4, out needed)) throw Win32("GetTokenInformation(TokenElevation)"); return Marshal.ReadInt32(b)!=0; } finally { Marshal.FreeHGlobal(b); }
    }
    public static uint Launch(string executable, string script, string installer, string expectedSid, string logPath, string workingDirectory) {
        if (IntPtr.Size!=8) throw new InvalidOperationException("Expected 64-bit Windows runner.");
        IntPtr parent=IntPtr.Zero, restricted=IntPtr.Zero, adminSid=IntPtr.Zero, groups=IntPtr.Zero, log=IntPtr.Zero, input=IntPtr.Zero;
        IntPtr attributeList=IntPtr.Zero, startupBuffer=IntPtr.Zero, inheritedHandles=IntPtr.Zero;
        TokenPrivileges priorAssign=default(TokenPrivileges), priorQuota=default(TokenPrivileges);
        bool assignEnabled=false, quotaEnabled=false;
        ProcessInformation pi = new ProcessInformation();
        try {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY|TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ADJUST_PRIVILEGES|TOKEN_ADJUST_DEFAULT, out parent)) throw Win32("OpenProcessToken(parent)");
            if (!IsElevated(parent)) throw new InvalidOperationException("GitHub hosted runner parent token is not elevated.");
            if (GetTokenType(parent)!=1) throw new InvalidOperationException("GitHub hosted runner token is not a primary token.");
            // CreateProcessAsUser does not require SeAssignPrimaryTokenPrivilege for this
            // caller-owned restricted token; enable it only if present and restore immediately.
            assignEnabled=TryEnablePrivilege(parent, "SeAssignPrimaryTokenPrivilege", out priorAssign);
            priorQuota=EnableRequiredPrivilege(parent, "SeIncreaseQuotaPrivilege"); quotaEnabled=true;
            adminSid = Sid("S-1-5-32-544");
            groups = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
            Marshal.StructureToPtr(new SidAndAttributes { Sid=adminSid, Attributes=0 }, groups, false);
            if (!CreateRestrictedToken(parent, DISABLE_MAX_PRIVILEGE, 1, groups, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted)) throw Win32("CreateRestrictedToken(DISABLE_MAX_PRIVILEGE, Administrators disabled)");
            SetMediumIntegrity(restricted);
            SecurityAttributes sa = new SecurityAttributes { nLength=Marshal.SizeOf(typeof(SecurityAttributes)), lpSecurityDescriptor=IntPtr.Zero, bInheritHandle=true };
            log=CreateFile(logPath, GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE, ref sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (log==new IntPtr(-1)) { log=IntPtr.Zero; throw Win32("CreateFile(log)"); }
            input=CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE, ref sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (input==new IntPtr(-1)) { input=IntPtr.Zero; throw Win32("Open NUL for child standard input"); }
            // The extended startup handle list below limits inheritance to these two standard handles.
            IntPtr attributeBytes=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            attributeList=Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes)) throw Win32("InitializeProcThreadAttributeList");
            inheritedHandles=Marshal.AllocHGlobal(IntPtr.Size*2);
            Marshal.WriteIntPtr(inheritedHandles, log);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size, input);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x00020002), inheritedHandles, new IntPtr(IntPtr.Size*2), IntPtr.Zero, IntPtr.Zero)) throw Win32("Restrict child handle inheritance");
            StartupInfo si = new StartupInfo { cb=Marshal.SizeOf(typeof(StartupInfoEx)), lpDesktop="winsta0\\default", dwFlags=(int)STARTF_USESTDHANDLES, hStdOutput=log, hStdError=log, hStdInput=input };
            StartupInfoEx six = new StartupInfoEx { StartupInfo=si, AttributeList=attributeList };
            startupBuffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(StartupInfoEx)));
            Marshal.StructureToPtr(six, startupBuffer, false);
            string args = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+script+"\" -InstallerPath \""+installer+"\" -ExpectedUserSid \""+expectedSid+"\" -ExpectedSessionId \""+CurrentSession()+"\"";
            StringBuilder cmd = new StringBuilder("\""+executable+"\" "+args);
            bool created=CreateProcessAsUserW(restricted, executable, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, workingDirectory, startupBuffer, out pi);
            int creationError=Marshal.GetLastWin32Error();
            Exception privilegeRestoreError=RestorePrivileges(parent, ref assignEnabled, ref priorAssign, ref quotaEnabled, ref priorQuota);
            if (!created) {
                if (privilegeRestoreError!=null) throw privilegeRestoreError;
                throw new Win32Exception(creationError, "CreateProcessAsUserW(reduced token, WinSta0\\Default)");
            }
            uint wait=WaitForSingleObject(pi.hProcess, INFINITE);
            if (wait!=WAIT_OBJECT_0) throw Win32("WaitForSingleObject(child)");
            uint code; if (!GetExitCodeProcess(pi.hProcess, out code)) throw Win32("GetExitCodeProcess(child)");
            if (privilegeRestoreError!=null) throw privilegeRestoreError;
            return code;
        } finally {
            if (pi.hThread!=IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess!=IntPtr.Zero) CloseHandle(pi.hProcess);
            if (attributeList!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
            if (startupBuffer!=IntPtr.Zero) Marshal.FreeHGlobal(startupBuffer);
            if (inheritedHandles!=IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandles);
            if (input!=IntPtr.Zero) CloseHandle(input);
            if (log!=IntPtr.Zero) CloseHandle(log);
            if (groups!=IntPtr.Zero) Marshal.FreeHGlobal(groups);
            if (adminSid!=IntPtr.Zero) LocalFree(adminSid);
            if (restricted!=IntPtr.Zero) CloseHandle(restricted);
            if (parent!=IntPtr.Zero) {
                Exception restoreError=RestorePrivileges(parent, ref assignEnabled, ref priorAssign, ref quotaEnabled, ref priorQuota);
                CloseHandle(parent);
                if (restoreError!=null) throw restoreError;
            }
        }
    }
    static uint CurrentSession() { uint session; uint pid=(uint)System.Diagnostics.Process.GetCurrentProcess().Id; if (!ProcessIdToSessionId(pid, out session)) throw Win32("ProcessIdToSessionId(parent)"); return session; }
}
'@

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$parentSession = [uint32][Diagnostics.Process]::GetCurrentProcess().SessionId
$parentElevated = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "Restricted-token lifecycle launcher"
Write-Output "Parent SID: $($identity.User.Value)"
Write-Output "Parent session: $parentSession"
Write-Output "Parent elevated: $parentElevated"
Write-Output 'Required privilege: SeIncreaseQuotaPrivilege. SeAssignPrimaryTokenPrivilege is enabled only if available. Privilege states are restored as soon as CreateProcessAsUserW returns.'
Write-Output 'Desktop: WinSta0\Default. The child inherits the token session and asserts it matches the parent; no desktop ACLs are changed.'
Write-Output 'This requires the fresh, ephemeral GitHub-hosted runneradmin profile and remains the same user identity with a reduced token.'
Write-Output 'UI availability is verified by the actual installed-app smoke; CreateProcessAsUser may fail if the reduced token cannot access the runner desktop.'
Write-Output 'Child context: same user/profile/session/default desktop, Administrators SID disabled, maximum privileges disabled, medium integrity.'
Write-Output 'This is a reduced-token test context, not a security sandbox.'
if (-not $parentElevated) { throw 'Expected the fresh GitHub runneradmin primary token to be elevated.' }

$exitCode = [ContextPickRestrictedLauncher]::Launch($powershell, $smokeScript, $installer, $identity.User.Value, $logPath, $repoRoot)
Write-Output "Child log: $logPath"
if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath }
Write-Output "Reduced-token lifecycle exit code: $exitCode"
if ($exitCode -ne 0) { throw "Reduced-token installed-app lifecycle failed with exit code $exitCode. See $logPath and test-results artifacts." }

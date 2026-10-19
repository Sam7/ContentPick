if (-not ('ContextPick.FilteredTokenLauncher' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace ContextPick {
    public sealed class FilteredTokenProcessInfo {
        public Process Process { get; set; }
        public int ProcessId { get; set; }
        public int SessionId { get; set; }
        public string UserSid { get; set; }
        public int IntegrityRid { get; set; }
        public int ElevationType { get; set; }
        public bool IsElevated { get; set; }
        public bool IsAdministrator { get; set; }
        public bool IsInteractive { get; set; }
    }

    public static class FilteredTokenLauncher {
        private const uint TokenQuery = 0x0008;
        private const uint TokenDuplicate = 0x0002;
        private const uint TokenAssignPrimary = 0x0001;
        private const int TokenIntegrityLevelInfo = 25;
        private const int TokenElevationTypeInfo = 18;
        private const int TokenLinkedTokenInfo = 19;
        private const int TokenElevationInfo = 20;
        private const int TokenSessionIdInfo = 12;
        private const int TokenElevationTypeFull = 2;
        private const int TokenElevationTypeLimited = 3;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint LogonWithProfile = 0x00000001;
        private const uint MediumIntegrityRid = 0x2000;
        private const int SecurityImpersonation = 2;
        private const int TokenImpersonation = 2;
        private const int TokenPrimary = 1;
        private const string AdministratorsSid = "S-1-5-32-544";
        private const string InteractiveSid = "S-1-5-4";

        [StructLayout(LayoutKind.Sequential)]
        private struct LinkedToken { public IntPtr Token; }
        [StructLayout(LayoutKind.Sequential)]
        private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)]
        private struct TokenMandatoryLabel { public SidAndAttributes Label; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        private static extern int GetCurrentProcessId();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(int processId, out int sessionId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int infoLength, out int returnLength);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string applicationName, StringBuilder commandLine, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CheckTokenMembership(IntPtr token, IntPtr sidToCheck, out bool isMember);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthorityIndex);

        private static byte[] Query(IntPtr token, int infoClass) {
            int length;
            GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
            if (length <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not size token information " + infoClass + ".");
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, infoClass, buffer, length, out length)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read token information " + infoClass + ".");
                byte[] result = new byte[length];
                Marshal.Copy(buffer, result, 0, length);
                return result;
            } finally { Marshal.FreeHGlobal(buffer); }
        }

        private static IntPtr QueryPointer(IntPtr token, int infoClass) {
            int length;
            GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
            if (length <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not size token information " + infoClass + ".");
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, infoClass, buffer, length, out length)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read token information " + infoClass + ".");
                return Marshal.ReadIntPtr(buffer);
            } finally { Marshal.FreeHGlobal(buffer); }
        }

        private static int QueryInt32(IntPtr token, int infoClass) {
            byte[] bytes = Query(token, infoClass);
            return BitConverter.ToInt32(bytes, 0);
        }

        private static int GetIntegrityRid(IntPtr token) {
            int length;
            GetTokenInformation(token, TokenIntegrityLevelInfo, IntPtr.Zero, 0, out length);
            if (length <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not size token integrity information.");
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, TokenIntegrityLevelInfo, buffer, length, out length)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read token integrity information.");
                TokenMandatoryLabel label = Marshal.PtrToStructure<TokenMandatoryLabel>(buffer);
                IntPtr countPointer = GetSidSubAuthorityCount(label.Label.Sid);
                if (countPointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read token integrity SID.");
                byte count = Marshal.ReadByte(countPointer);
                if (count == 0) throw new InvalidOperationException("Token integrity SID has no subauthorities.");
                IntPtr ridPointer = GetSidSubAuthority(label.Label.Sid, (uint)(count - 1));
                if (ridPointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read token integrity RID.");
                return Marshal.ReadInt32(ridPointer);
            } finally { Marshal.FreeHGlobal(buffer); }
        }

        private static string GetSid(IntPtr token) {
            using (WindowsIdentity identity = new WindowsIdentity(token)) {
                if (identity.User == null) throw new InvalidOperationException("Linked filtered token has no user SID.");
                return identity.User.Value;
            }
        }

        private static bool HasGroupMembership(IntPtr token, string sidText) {
            IntPtr adminSid = IntPtr.Zero;
            IntPtr impersonation = IntPtr.Zero;
            try {
                if (!ConvertStringSidToSid(sidText, out adminSid)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create a required group SID.");
                if (!DuplicateTokenEx(token, TokenQuery | TokenDuplicate, IntPtr.Zero, SecurityImpersonation, TokenImpersonation, out impersonation)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not duplicate linked token for membership check.");
                bool member;
                if (!CheckTokenMembership(impersonation, adminSid, out member)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not check required group membership for linked token.");
                return member;
            } finally {
                if (impersonation != IntPtr.Zero) CloseHandle(impersonation);
                if (adminSid != IntPtr.Zero) LocalFree(adminSid);
            }
        }

        private static IntPtr GetLimitedLinkedToken() {
            IntPtr currentToken = IntPtr.Zero;
            IntPtr linkedBuffer = IntPtr.Zero;
            IntPtr linkedToken = IntPtr.Zero;
            try {
                if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenDuplicate, out currentToken)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open runner process token.");
                int elevationType = QueryInt32(currentToken, TokenElevationTypeInfo);
                if (elevationType != TokenElevationTypeFull) throw new InvalidOperationException("Runner process does not have a full UAC token with a linked filtered token (elevation type " + elevationType + ").");
                int length;
                GetTokenInformation(currentToken, TokenLinkedTokenInfo, IntPtr.Zero, 0, out length);
                if (length < Marshal.SizeOf<LinkedToken>()) throw new InvalidOperationException("Runner token has no linked filtered token.");
                linkedBuffer = Marshal.AllocHGlobal(length);
                if (!GetTokenInformation(currentToken, TokenLinkedTokenInfo, linkedBuffer, length, out length)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read runner's linked filtered token.");
                linkedToken = Marshal.PtrToStructure<LinkedToken>(linkedBuffer).Token;
                IntPtr primary;
                uint access = TokenQuery | TokenDuplicate | TokenAssignPrimary;
                if (!DuplicateTokenEx(linkedToken, access, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not duplicate linked filtered token as a primary token.");
                return primary;
            } finally {
                if (linkedToken != IntPtr.Zero) CloseHandle(linkedToken);
                if (linkedBuffer != IntPtr.Zero) Marshal.FreeHGlobal(linkedBuffer);
                if (currentToken != IntPtr.Zero) CloseHandle(currentToken);
            }
        }

        public static FilteredTokenProcessInfo InspectLinkedToken() {
            IntPtr token = GetLimitedLinkedToken();
            try {
                int runnerSession;
                if (!ProcessIdToSessionId(GetCurrentProcessId(), out runnerSession)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not determine runner session.");
                int tokenSession = QueryInt32(token, TokenSessionIdInfo);
                int elevationType = QueryInt32(token, TokenElevationTypeInfo);
                byte[] elevationBytes = Query(token, TokenElevationInfo);
                bool elevated = BitConverter.ToInt32(elevationBytes, 0) != 0;
                string sid = GetSid(token);
                using (WindowsIdentity parent = WindowsIdentity.GetCurrent()) {
                    if (!String.Equals(sid, parent.User.Value, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Linked token SID differs from the runner SID.");
                }
                int integrity = GetIntegrityRid(token);
                bool administrator = HasGroupMembership(token, AdministratorsSid);
                bool interactive = HasGroupMembership(token, InteractiveSid);
                if (tokenSession != runnerSession || elevationType != TokenElevationTypeLimited || elevated || administrator || !interactive || integrity != MediumIntegrityRid) {
                    throw new InvalidOperationException("Runner linked token does not meet the interactive, same-session, medium-integrity non-elevated token requirements.");
                }
                return new FilteredTokenProcessInfo {
                    ProcessId = 0, SessionId = tokenSession, UserSid = sid, IntegrityRid = integrity,
                    ElevationType = elevationType, IsElevated = elevated,
                    IsAdministrator = administrator, IsInteractive = interactive
                };
            } finally { CloseHandle(token); }
        }

        public static FilteredTokenProcessInfo InspectCurrent() {
            IntPtr token = IntPtr.Zero;
            try {
                if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenDuplicate, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open current process token for evidence.");
                int session;
                if (!ProcessIdToSessionId(GetCurrentProcessId(), out session)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not determine current process session.");
                byte[] elevationBytes = Query(token, TokenElevationInfo);
                return new FilteredTokenProcessInfo {
                    ProcessId = GetCurrentProcessId(), SessionId = session, UserSid = GetSid(token),
                    IntegrityRid = GetIntegrityRid(token), ElevationType = QueryInt32(token, TokenElevationTypeInfo),
                    IsElevated = BitConverter.ToInt32(elevationBytes, 0) != 0,
                    IsAdministrator = HasGroupMembership(token, AdministratorsSid),
                    IsInteractive = HasGroupMembership(token, InteractiveSid)
                };
            } finally { if (token != IntPtr.Zero) CloseHandle(token); }
        }

        public static FilteredTokenProcessInfo Start(string applicationPath, string commandLine, string workingDirectory, string environmentBlock) {
            IntPtr token = GetLimitedLinkedToken();
            IntPtr environment = IntPtr.Zero;
            ProcessInformation process = new ProcessInformation();
            try {
                int currentSession;
                if (!ProcessIdToSessionId(GetCurrentProcessId(), out currentSession)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not determine runner session.");
                if (currentSession == 0) throw new InvalidOperationException("Runner process is in session 0, which has no interactive desktop.");
                int tokenSession = QueryInt32(token, TokenSessionIdInfo);
                int elevationType = QueryInt32(token, TokenElevationTypeInfo);
                byte[] elevationBytes = Query(token, TokenElevationInfo);
                bool elevated = BitConverter.ToInt32(elevationBytes, 0) != 0;
                string sid = GetSid(token);
                using (WindowsIdentity parent = WindowsIdentity.GetCurrent()) {
                    if (!String.Equals(sid, parent.User.Value, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Linked token SID differs from the runner SID.");
                }
                int integrity = GetIntegrityRid(token);
                bool administrator = HasGroupMembership(token, AdministratorsSid);
                bool interactive = HasGroupMembership(token, InteractiveSid);
                if (tokenSession != currentSession) throw new InvalidOperationException("Linked token session differs from the runner session.");
                if (elevationType != TokenElevationTypeLimited || elevated || administrator) throw new InvalidOperationException("Linked token is not a limited non-administrator token.");
                if (!interactive) throw new InvalidOperationException("Linked token is not a member of the INTERACTIVE logon group.");
                if (integrity != MediumIntegrityRid) throw new InvalidOperationException("Linked token integrity is not medium (RID " + integrity + ").");

                StartupInfo startup = new StartupInfo();
                startup.cb = Marshal.SizeOf<StartupInfo>();
                if (String.IsNullOrEmpty(environmentBlock) || environmentBlock.Length < 2 || environmentBlock[environmentBlock.Length - 1] != '\0' || environmentBlock[environmentBlock.Length - 2] != '\0') {
                    throw new ArgumentException("Child environment must be an explicit double-NUL-terminated Unicode block.", "environmentBlock");
                }
                environment = Marshal.StringToHGlobalUni(environmentBlock);
                StringBuilder mutableCommandLine = new StringBuilder(commandLine);
                if (!CreateProcessWithTokenW(token, LogonWithProfile, applicationPath, mutableCommandLine, CreateUnicodeEnvironment, environment, workingDirectory, ref startup, out process)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start child process with the linked filtered token.");
                }
                Process childProcess = Process.GetProcessById(process.dwProcessId);
                return new FilteredTokenProcessInfo {
                    Process = childProcess,
                    ProcessId = process.dwProcessId,
                    SessionId = tokenSession,
                    UserSid = sid,
                    IntegrityRid = integrity,
                    ElevationType = elevationType,
                    IsElevated = elevated,
                    IsAdministrator = administrator,
                    IsInteractive = interactive
                };
            } finally {
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (token != IntPtr.Zero) CloseHandle(token);
            }
        }
    }
}
'@
}

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [System.Text.StringBuilder]::new('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes++; continue }
        if ($character -eq '"') {
            $null = $builder.Append(('\' * (($backslashes * 2) + 1))).Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { $null = $builder.Append(('\' * $backslashes)); $backslashes = 0 }
        $null = $builder.Append($character)
    }
    if ($backslashes -gt 0) { $null = $builder.Append(('\' * ($backslashes * 2))) }
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Start-ContextPickFilteredTokenProcess {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [Parameter(Mandatory = $true)] [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)] [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)] [System.Collections.IDictionary]$Environment
    )
    $resolvedFile = [System.IO.Path]::GetFullPath($FilePath)
    if (-not (Test-Path -LiteralPath $resolvedFile -PathType Leaf)) { throw "Filtered-token executable does not exist: $resolvedFile." }
    $commandLine = (@($resolvedFile) + $ArgumentList | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' '
    $environmentEntries = [System.Collections.Generic.List[string]]::new()
    foreach ($key in @($Environment.Keys | Sort-Object)) {
        $value = $Environment[$key]
        if ($null -ne $value) {
            $name = [string]$key
            $text = [string]$value
            if ($name.Contains('=') -or $name.Contains([char]0) -or $text.Contains([char]0)) { throw "Invalid child environment entry: $name." }
            $environmentEntries.Add("$name=$text")
        }
    }
    $environmentBlock = [string]::Join([char]0, $environmentEntries) + [char]0 + [char]0
    $started = [ContextPick.FilteredTokenLauncher]::Start($resolvedFile, $commandLine, [System.IO.Path]::GetFullPath($WorkingDirectory), $environmentBlock)
    [pscustomobject]@{ Process = $started.Process; Token = $started }
}

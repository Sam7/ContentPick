function Test-RestrictedNativeProcessStart {
    $executablePath = Join-Path ([Environment]::SystemDirectory) 'whoami.exe'
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "Native process preflight executable is missing: $executablePath"
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $executablePath
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.ArgumentList.Add('/user')

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Process.Start returned false for the native process preflight.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill($true)
            throw 'The native process preflight exceeded its 10 second bound.'
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) {
            throw "Native process preflight exited with code $($process.ExitCode). stdout: $stdout stderr: $stderr"
        }
        Write-Output "Restricted-token native process preflight passed: $stdout"
    } catch [System.ComponentModel.Win32Exception] {
        throw "Restricted-token native process start failed with Win32 error $($_.Exception.NativeErrorCode): $($_.Exception.Message)"
    } finally {
        $process.Dispose()
    }
}

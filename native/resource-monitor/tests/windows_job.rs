#![cfg(windows)]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};

const LAUNCHER: &str = r#"
$cli = [Diagnostics.Process]::new()
$cli.StartInfo.FileName = 'powershell.exe'
$cli.StartInfo.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
$cli.StartInfo.UseShellExecute = $false
$cli.StartInfo.CreateNoWindow = $true
$null = $cli.Start()
[Console]::WriteLine($cli.Id)
[Console]::ReadLine() | Out-Null
"#;

fn assert_job_stops_cli(close_input: bool) {
    let mut owner = Command::new(env!("CARGO_BIN_EXE_t3-resource-monitor"))
        .args([
            "--run-in-job",
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            LAUNCHER,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut pid = String::new();
    stdout.read_line(&mut pid).unwrap();
    let cli = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid.trim().parse().unwrap()) }
        .expect("fixture CLI is running");
    if close_input {
        // The launcher exits on EOF, even though its CLI ignores the pipe.
        drop(owner.stdin.take());
    } else {
        owner.kill().unwrap();
    }
    owner.wait().unwrap();
    let status = unsafe { WaitForSingleObject(cli, 5_000) };
    unsafe { CloseHandle(cli).unwrap() };
    assert_eq!(status, WAIT_OBJECT_0, "fixture CLI survived the job owner");
}

#[test]
fn job_stops_the_cli_when_the_launcher_exits_on_eof() {
    assert_job_stops_cli(true);
}

#[test]
fn job_stops_the_cli_when_the_owner_is_killed() {
    assert_job_stops_cli(false);
}

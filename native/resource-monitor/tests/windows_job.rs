#![cfg(windows)]

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::mem::size_of_val;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::process::{Command, Stdio};
use windows::Win32::Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
use windows::core::PCWSTR;

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

fn create_pipe(name: &str) -> File {
    let wide: Vec<_> = name.encode_utf16().chain([0]).collect();
    let pipe = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
            2,
            4096,
            4096,
            0,
            None,
        )
    };
    assert!(!pipe.is_invalid());
    unsafe { File::from_raw_handle(pipe.0) }
}

fn connect(pipe: &mut File) -> u8 {
    if let Err(error) = unsafe { ConnectNamedPipe(HANDLE(pipe.as_raw_handle()), None) } {
        assert_eq!(error.code(), ERROR_PIPE_CONNECTED.to_hresult());
    }
    let mut role = [0];
    pipe.read_exact(&mut role).unwrap();
    role[0]
}

fn assert_job_stops_cli(action: &str) {
    let name = format!("t3-job-test-{}-{action}", std::process::id());
    let pipe_name = format!(r"\\.\pipe\{name}");
    let gate = format!(r"Local\{name}");
    let mut first = create_pipe(&pipe_name);
    let mut second = create_pipe(&pipe_name);
    let mut owner = Command::new(env!("CARGO_BIN_EXE_t3-resource-monitor"))
        .args([
            "--run-in-job",
            &pipe_name,
            &gate,
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
    let (mut control, mut receipt) = match (connect(&mut first), connect(&mut second)) {
        (b'C', b'A') => (first, second),
        (b'A', b'C') => (second, first),
        roles => panic!("invalid pipe roles: {roles:?}"),
    };
    if action == "start-fails" {
        // Force the controller's trampoline spawn to fail before the gate can open.
        let outer_job = unsafe { CreateJobObjectW(None, None).unwrap() };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        unsafe {
            SetInformationJobObject(
                outer_job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            )
            .unwrap();
            AssignProcessToJobObject(outer_job, HANDLE(owner.as_raw_handle())).unwrap();
        }
        control.write_all(b"S").unwrap();
        let mut confirmation = [0];
        let result = receipt.read_exact(&mut confirmation);
        let status = owner.wait().unwrap();
        unsafe { CloseHandle(outer_job).unwrap() };
        result.expect("a pre-launch failure must release ownership");
        assert_eq!(confirmation, *b"F");
        assert!(!status.success());
        return;
    }
    control.write_all(b"S").unwrap();
    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut pid = String::new();
    stdout.read_line(&mut pid).unwrap();
    let cli = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid.trim().parse().unwrap()) }
        .expect("fixture CLI is running");
    match action {
        // The launcher exits on EOF, even though its CLI ignores the pipe.
        "eof" => drop(owner.stdin.take()),
        "stop" => control.write_all(b"T").unwrap(),
        "kill" => owner.kill().unwrap(),
        _ => unreachable!(),
    }
    let mut confirmation = [0];
    if action == "kill" {
        assert!(receipt.read_exact(&mut confirmation).is_err());
    } else {
        receipt.read_exact(&mut confirmation).unwrap();
        assert_eq!(confirmation, *b"D");
    }
    let status = unsafe { WaitForSingleObject(cli, if action == "kill" { 5_000 } else { 0 }) };
    unsafe { CloseHandle(cli).unwrap() };
    owner.wait().unwrap();
    assert_eq!(
        status, WAIT_OBJECT_0,
        "fixture CLI survived the job shutdown"
    );
}

#[test]
fn job_stops_the_cli_when_the_launcher_exits_on_eof() {
    assert_job_stops_cli("eof");
}

#[test]
fn job_confirms_a_requested_stop_after_the_cli_exits() {
    assert_job_stops_cli("stop");
}

#[test]
fn job_stops_the_cli_without_a_receipt_when_the_owner_is_killed() {
    assert_job_stops_cli("kill");
}

#[test]
fn job_reports_a_failure_before_launching_the_cli() {
    assert_job_stops_cli("start-fails");
}

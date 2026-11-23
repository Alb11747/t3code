use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::mem::{forget, offset_of, size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, HANDLE, WAIT_OBJECT_0,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateEventW, INFINITE, OpenEventW, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, SYNCHRONIZATION_SYNCHRONIZE, SetEvent,
    WaitForMultipleObjects, WaitForSingleObject,
};
use windows::core::{BOOL, PCWSTR};

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn argument(args: &mut impl Iterator<Item = OsString>) -> io::Result<OsString> {
    args.next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing Windows job argument"))
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}

fn set_limits(job: HANDLE, limits: &JOBOBJECT_EXTENDED_LIMIT_INFORMATION) -> io::Result<()> {
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(limits) as u32,
        )?;
    }
    Ok(())
}

fn retain_job_processes(job: HANDLE) -> io::Result<Vec<OwnedHandle>> {
    const PREFIX: usize =
        offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) / size_of::<usize>();
    let mut data = vec![0usize; PREFIX + 32];
    let handles = loop {
        let bytes = u32::try_from(size_of_val(data.as_slice())).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Windows job process list is too large",
            )
        })?;
        let result = unsafe {
            QueryInformationJobObject(
                Some(job),
                JobObjectBasicProcessIdList,
                data.as_mut_ptr().cast(),
                bytes,
                None,
            )
        };
        if let Err(error) = result {
            if error.code() != ERROR_MORE_DATA.to_hresult() {
                return Err(error.into());
            }
            data.resize(data.len() * 2, 0);
            continue;
        }
        let header = unsafe { &*data.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
        break &data[PREFIX..PREFIX + header.NumberOfProcessIdsInList as usize];
    };
    let mut retained = Vec::with_capacity(handles.len());
    for &pid in handles {
        let result = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid as u32,
            )
        };
        let process = match result {
            Ok(handle) => OwnedHandle(handle),
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => continue,
            Err(error) => return Err(error.into()),
        };
        let mut belongs_to_job = BOOL(0);
        unsafe { IsProcessInJob(process.0, Some(job), &mut belongs_to_job)? };
        if belongs_to_job.as_bool() {
            retained.push(process);
        }
    }
    Ok(retained)
}

fn wait_for_processes(processes: Vec<OwnedHandle>) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    for process in processes {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if unsafe { WaitForSingleObject(process.0, remaining.as_millis() as u32) } != WAIT_OBJECT_0
        {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Windows job process did not exit",
            ));
        }
    }
    Ok(())
}

fn wait_for_empty_job(job: HANDLE) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(job),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&accounting) as u32,
                None,
            )?;
        }
        if accounting.ActiveProcesses == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Windows job is not empty",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<()> {
    let pipe = argument(&mut args)?;
    let gate_name = argument(&mut args)?;
    let gate = wide(&gate_name);
    let mut control = OpenOptions::new().read(true).write(true).open(&pipe)?;
    control.write_all(b"C")?;
    // A separate pipe instance lets the receipt write proceed while the stop reader is blocked.
    let mut receipts = OpenOptions::new().write(true).open(pipe)?;
    receipts.write_all(b"A")?;
    let mut message = [0];
    if control.read_exact(&mut message).is_err() || message != *b"S" {
        // There is no child before the server explicitly authorizes it.
        receipts.write_all(b"D")?;
        return Ok(());
    }

    let job = OwnedHandle(unsafe { CreateJobObjectW(None, None)? });
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    set_limits(job.0, &limits)?;
    let start = OwnedHandle(unsafe { CreateEventW(None, true, false, PCWSTR(gate.as_ptr()))? });
    let stop = OwnedHandle(unsafe { CreateEventW(None, true, false, PCWSTR::null())? });
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--run-in-job-child")
        .arg(gate_name)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()?;
    let child_handle = HANDLE(child.as_raw_handle());
    if let Err(error) = unsafe { AssignProcessToJobObject(job.0, child_handle) } {
        child.kill()?;
        child.wait()?;
        receipts.write_all(b"D")?;
        return Err(error.into());
    }
    // The reader owns its stop handle until process exit, including when no stop is needed.
    let stop_handle = stop.0.0 as usize;
    forget(stop);
    std::thread::spawn(move || {
        let _ = control.read(&mut [0]);
        let _ = unsafe { SetEvent(HANDLE(stop_handle as *mut _)) };
    });
    unsafe { SetEvent(start.0)? };
    let event = unsafe {
        WaitForMultipleObjects(
            &[child_handle, HANDLE(stop_handle as *mut _)],
            false,
            INFINITE,
        )
    };
    if event != WAIT_OBJECT_0 && event.0 != WAIT_OBJECT_0.0 + 1 {
        return Err(io::Error::last_os_error());
    }
    // Stop admitting children before capturing handles. The job's active count can reach zero
    // before the kernel signals those handles.
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    set_limits(job.0, &limits)?;
    let processes = retain_job_processes(job.0)?;
    unsafe { TerminateJobObject(job.0, 1)? };
    let status = child.wait()?;
    wait_for_processes(processes)?;
    wait_for_empty_job(job.0)?;
    // An exit status cannot stand in for this receipt. Kernel teardown can still be running.
    receipts.write_all(b"D")?;
    std::process::exit(status.code().unwrap_or(1));
}

pub fn run_child(mut args: impl Iterator<Item = OsString>) -> io::Result<()> {
    let name = argument(&mut args)?;
    let command = argument(&mut args)?;
    let gate = wide(&name);
    let start = OwnedHandle(unsafe {
        OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(gate.as_ptr()))?
    });
    // An owner that dies before assigning this process never opens the gate.
    if unsafe { WaitForSingleObject(start.0, 10_000) } != WAIT_OBJECT_0 {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Windows job was not assigned",
        ));
    }
    let status = Command::new(command)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW.0)
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

use std::ffi::OsString;
use std::io;
use std::mem::{forget, size_of_val};
use std::os::windows::process::CommandExt;
use std::process::Command;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::Threading::{CREATE_NO_WINDOW, GetCurrentProcess};

struct Job(HANDLE);

impl Drop for Job {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<()> {
    let command = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "expected a job command"))?;
    let job = Job(unsafe { CreateJobObjectW(None, None)? });
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )?;
        // Joining before spawning makes membership automatic, even for a launcher that exits
        // immediately. The handle is private to this helper and closes when it dies.
        AssignProcessToJobObject(job.0, GetCurrentProcess())?;
    }
    forget(job);
    let status = Command::new(command)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW.0)
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

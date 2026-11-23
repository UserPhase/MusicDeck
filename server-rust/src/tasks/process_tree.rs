//! Platform process ownership for the external runner. The OS calls are confined here.
#![allow(unsafe_code)]

use std::io;
use tokio::process::{Child, Command};

#[cfg(unix)]
pub(super) struct ProcessTree(u32);

#[cfg(unix)]
impl ProcessTree {
    pub(super) fn configure(command: &mut Command) {
        command.process_group(0);
    }

    pub(super) fn attach(child: &Child) -> io::Result<Self> {
        child
            .id()
            .map(Self)
            .ok_or_else(|| io::Error::other("Missing process ID"))
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: The fresh child's PID is also its positive, isolated process group ID.
        unsafe { libc::kill(-(self.0 as libc::pid_t), libc::SIGKILL) };
    }
}

#[cfg(windows)]
pub(super) struct ProcessTree {
    _job: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl ProcessTree {
    pub(super) fn configure(command: &mut Command) {
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    pub(super) fn attach(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*};

        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("Missing process ID"))?;
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Missing process handle"))?;
        // SAFETY: All returned handles are validated and owned by this function. Struct sizes
        // match the Win32 APIs, and the suspended child cannot run before it joins the job.
        unsafe {
            let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw_job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = OwnedHandle::from_raw_handle(raw_job);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job.as_raw_handle(), process) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let raw_snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if raw_snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let snapshot = OwnedHandle::from_raw_handle(raw_snapshot);
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry);
            while found != 0 {
                if entry.th32OwnerProcessID == pid {
                    let raw_thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if raw_thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    let thread = OwnedHandle::from_raw_handle(raw_thread);
                    if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                        return Err(io::Error::last_os_error());
                    }
                    return Ok(Self { _job: job });
                }
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                found = Thread32Next(snapshot.as_raw_handle(), &mut entry);
            }
            Err(io::Error::other(
                "Could not find the suspended process thread",
            ))
        }
    }
}

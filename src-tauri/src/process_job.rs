use std::sync::Arc;

#[cfg(windows)]
mod platform {
    use std::{ffi::c_void, sync::Arc};

    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct ProcessJob(HANDLE);

    unsafe impl Send for ProcessJob {}
    unsafe impl Sync for ProcessJob {}

    impl ProcessJob {
        pub fn attach(child: &tokio::process::Child) -> Option<Arc<Self>> {
            let process = child.raw_handle()?;
            let job = unsafe { CreateJobObjectW(None, None) }.ok()?;
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &information as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured.is_err() {
                let _ = unsafe { CloseHandle(job) };
                return None;
            }
            let process = HANDLE(process as *mut _);
            if unsafe { AssignProcessToJobObject(job, process) }.is_err() {
                let _ = unsafe { CloseHandle(job) };
                return None;
            }
            Some(Arc::new(Self(job)))
        }

        pub fn terminate(&self) {
            let _ = unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::sync::Arc;

    pub struct ProcessJob;

    impl ProcessJob {
        pub fn attach(_child: &tokio::process::Child) -> Option<Arc<Self>> {
            None
        }

        pub fn terminate(&self) {}
    }
}

pub use platform::ProcessJob;

pub fn attach(child: &tokio::process::Child) -> Option<Arc<ProcessJob>> {
    let job = ProcessJob::attach(child);
    if job.is_none() {
        log::warn!("无法把下载进程加入 Windows Job Object；暂停/取消时可能无法回收 ffmpeg 子进程");
    }
    job
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::process::Command;

    #[tokio::test]
    async fn terminates_assigned_process() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping", "127.0.0.1", "-n", "30"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn test process");
        let job = attach(&child).expect("attach job object");
        job.terminate();
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("process should stop after job termination")
            .expect("wait for test process");
        assert!(!status.success());
    }
}

//! # Safe External Process Runner & Bounded Stream Capture (`tasks::process_runner`)
//!
//! Ports `server/src/domain/process-runner.ts`:
//! - [`ProcessOptions`], [`ProcessExecutionResult`], [`ProcessError`], and [`ProcessRunner`] trait
//! - [`DefaultProcessRunner`]:
//!   - Spawns external binaries (`ffmpeg`, `ffprobe`, `spotdl`) strictly via argument arrays
//!     using `tokio::process::Command` (`stdin = null`, `stdout = piped`, `stderr = piped`,
//!     `kill_on_drop(true)`).
//!   - Bounds captured `stdout` and `stderr` buffers to [`MAX_CAPTURE_BYTES_PER_STREAM`] (`512 KiB`)
//!     using a rolling tail ring buffer (`append_bounded`) and partial line buffers to
//!     [`MAX_PARTIAL_LINE_BYTES`] (`64 KiB`).
//!   - Enforces execution timeouts (`timeout_ms`) and cooperative cancellation via
//!     [`tokio_util::sync::CancellationToken`] and `tokio::select!`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::services::privacy::ExternalCategory;

/// Maximum bytes retained per standard stream (`512 KiB`).
pub const MAX_CAPTURE_BYTES_PER_STREAM: usize = 512 * 1024;
/// Maximum bytes retained in a partial line buffer (`64 KiB`).
pub const MAX_PARTIAL_LINE_BYTES: usize = 64 * 1024;

/// Callback invoked for each complete non-empty line or raw chunk emitted by a child process.
pub type StreamCallback = Arc<dyn Fn(&str) + Send + Sync>;

/// Execution options for [`ProcessRunner::run`].
#[derive(Clone, Default)]
pub struct ProcessOptions {
    pub privacy_category: Option<ExternalCategory>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
    pub cancel_token: Option<CancellationToken>,
    pub on_stdout_line: Option<StreamCallback>,
    pub on_stderr_line: Option<StreamCallback>,
    pub on_stdout_chunk: Option<StreamCallback>,
    pub on_stderr_chunk: Option<StreamCallback>,
}

impl std::fmt::Debug for ProcessOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessOptions")
            .field("privacy_category", &self.privacy_category)
            .field("cwd", &self.cwd)
            .field("timeout_ms", &self.timeout_ms)
            .finish()
    }
}

/// Completed execution outcome of a child process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExecutionResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub signal: Option<String>,
}

/// Structured error returned when a child process fails to spawn, times out, or is cancelled.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProcessError {
    #[error("Process was cancelled")]
    Cancelled,
    #[error("Process timed out after {0}ms")]
    TimedOut(u64),
    #[error("Failed to spawn process '{command}': {reason}")]
    SpawnFailed { command: String, reason: String },
    #[error("Process I/O failure: {0}")]
    Io(String),
}

/// Appends `chunk` to `current` while capping the total buffer length to the trailing `limit` bytes.
pub fn append_bounded(current: &mut Vec<u8>, chunk: &[u8], limit: usize) {
    if chunk.len() >= limit {
        current.clear();
        current.extend_from_slice(&chunk[chunk.len() - limit..]);
        return;
    }
    let total = current.len().saturating_add(chunk.len());
    if total > limit {
        let drop_count = total - limit;
        current.drain(0..drop_count);
    }
    current.extend_from_slice(chunk);
}

fn process_stream_chunk(
    captured: &mut Vec<u8>,
    line_buf: &mut Vec<u8>,
    chunk: &[u8],
    on_chunk: Option<&StreamCallback>,
    on_line: Option<&StreamCallback>,
) {
    append_bounded(captured, chunk, MAX_CAPTURE_BYTES_PER_STREAM);
    let text = String::from_utf8_lossy(chunk);
    if let Some(cb) = on_chunk {
        cb(&text);
    }

    if let Some(cb) = on_line {
        line_buf.extend_from_slice(chunk);
        let combined = String::from_utf8_lossy(line_buf).into_owned();
        let mut parts: Vec<&str> = combined.split(['\n', '\r']).collect();
        let trailing = parts.pop().unwrap_or("");
        for line in parts {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                cb(trimmed);
            }
        }
        line_buf.clear();
        let trailing_bytes = trailing.as_bytes();
        if trailing_bytes.len() > MAX_PARTIAL_LINE_BYTES {
            line_buf.extend_from_slice(
                &trailing_bytes[trailing_bytes.len() - MAX_PARTIAL_LINE_BYTES..],
            );
        } else {
            line_buf.extend_from_slice(trailing_bytes);
        }
    }
}

/// Trait abstracting external binary execution so downloaders and media analyzers
/// can be deterministically unit-tested without spawning OS processes.
#[async_trait]
pub trait ProcessRunner: Send + Sync {
    /// Executes `command` with `args` and `options`, returning [`ProcessExecutionResult`].
    async fn run(
        &self,
        command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError>;
}

/// Production [`ProcessRunner`] backed by `tokio::process::Command`.
#[derive(Debug, Clone, Default)]
pub struct DefaultProcessRunner;

impl DefaultProcessRunner {
    /// Creates a new [`DefaultProcessRunner`].
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ProcessRunner for DefaultProcessRunner {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        if let Some(ref token) = options.cancel_token {
            if token.is_cancelled() {
                return Err(ProcessError::Cancelled);
            }
        }

        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(ref cwd) = options.cwd {
            cmd.current_dir(cwd);
        }
        if !options.env.is_empty() {
            cmd.envs(&options.env);
        }

        let mut child = cmd.spawn().map_err(|err| ProcessError::SpawnFailed {
            command: command.to_owned(),
            reason: err.to_string(),
        })?;

        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();

        let mut stdout_data = Vec::new();
        let mut stderr_data = Vec::new();
        let mut stdout_line_buf = Vec::new();
        let mut stderr_line_buf = Vec::new();

        let cancel_token = options.cancel_token.unwrap_or_default();
        let timeout_duration = options
            .timeout_ms
            .filter(|&ms| ms > 0)
            .map(Duration::from_millis);

        let drive_io = async {
            let mut out_buf = [0_u8; 8192];
            let mut err_buf = [0_u8; 8192];
            let mut out_eof = stdout_pipe.is_none();
            let mut err_eof = stderr_pipe.is_none();

            while !out_eof || !err_eof {
                tokio::select! {
                    res = async {
                        match stdout_pipe.as_mut() {
                            Some(s) => s.read(&mut out_buf).await,
                            None => Ok(0),
                        }
                    }, if !out_eof => {
                        match res {
                            Ok(0) | Err(_) => out_eof = true,
                            Ok(n) => {
                                process_stream_chunk(
                                    &mut stdout_data,
                                    &mut stdout_line_buf,
                                    &out_buf[..n],
                                    options.on_stdout_chunk.as_ref(),
                                    options.on_stdout_line.as_ref(),
                                );
                            }
                        }
                    }
                    res = async {
                        match stderr_pipe.as_mut() {
                            Some(s) => s.read(&mut err_buf).await,
                            None => Ok(0),
                        }
                    }, if !err_eof => {
                        match res {
                            Ok(0) | Err(_) => err_eof = true,
                            Ok(n) => {
                                process_stream_chunk(
                                    &mut stderr_data,
                                    &mut stderr_line_buf,
                                    &err_buf[..n],
                                    options.on_stderr_chunk.as_ref(),
                                    options.on_stderr_line.as_ref(),
                                );
                            }
                        }
                    }
                }
            }

            child
                .wait()
                .await
                .map_err(|err| ProcessError::Io(err.to_string()))
        };

        let status = match timeout_duration {
            Some(dur) => {
                tokio::select! {
                    () = cancel_token.cancelled() => {
                        let _ = child.kill().await;
                        return Err(ProcessError::Cancelled);
                    }
                    timed = tokio::time::timeout(dur, drive_io) => {
                        match timed {
                            Ok(res) => res?,
                            Err(_) => {
                                let _ = child.kill().await;
                                return Err(ProcessError::TimedOut(options.timeout_ms.unwrap_or(0)));
                            }
                        }
                    }
                }
            }
            None => {
                tokio::select! {
                    () = cancel_token.cancelled() => {
                        let _ = child.kill().await;
                        return Err(ProcessError::Cancelled);
                    }
                    res = drive_io => res?,
                }
            }
        };

        if let Some(ref cb) = options.on_stdout_line {
            let rem = String::from_utf8_lossy(&stdout_line_buf);
            let trimmed = rem.trim();
            if !trimmed.is_empty() {
                cb(trimmed);
            }
        }
        if let Some(ref cb) = options.on_stderr_line {
            let rem = String::from_utf8_lossy(&stderr_line_buf);
            let trimmed = rem.trim();
            if !trimmed.is_empty() {
                cb(trimmed);
            }
        }

        Ok(ProcessExecutionResult {
            exit_code: status.code(),
            stdout: String::from_utf8_lossy(&stdout_data).into_owned(),
            stderr: String::from_utf8_lossy(&stderr_data).into_owned(),
            signal: None,
        })
    }
}

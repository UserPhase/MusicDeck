use std::path::Path;
use std::sync::Arc;

use tokio::sync::OnceCell;

use crate::tasks::{ProcessOptions, ProcessRunner};

pub(super) const AUDIO_INPUT_FORMATS: &str = "aac,aiff,ape,asf,caf,flac,matroska,webm,mp3,mov,mp4,m4a,3gp,3g2,mj2,ogg,wav,wv,dsf,ac3,eac3,tta";

#[derive(Clone, Debug)]
pub(super) struct Ffmpeg {
    filter: &'static str,
    configured: Option<String>,
    discovered: Arc<OnceCell<String>>,
}

impl Ffmpeg {
    pub(super) fn from_env(filter: &'static str) -> Self {
        Self {
            filter,
            configured: std::env::var("FFMPEG_PATH")
                .ok()
                .as_deref()
                .and_then(configured_ffmpeg),
            discovered: Arc::default(),
        }
    }

    pub(super) fn configured(filter: &'static str, binary: String) -> Self {
        Self {
            filter,
            configured: Some(binary),
            discovered: Arc::default(),
        }
    }

    pub(super) async fn resolve(&self, runner: &dyn ProcessRunner) -> Result<&str, String> {
        let binary = self.discovered.get_or_try_init(|| async {
            let home = std::env::home_dir();
            for candidate in ffmpeg_candidates(self.configured.as_deref(), home.as_deref()) {
                let outcome = runner.run(
                    &candidate, &["-hide_banner".into(), "-filters".into()],
                    ProcessOptions { timeout_ms: Some(3_000), ..ProcessOptions::default() },
                ).await;
                match outcome {
                    Ok(result) if result.exit_code == Some(0) && result.stdout.lines()
                        .any(|line| line.split_whitespace().nth(1) == Some(self.filter)) =>
                    {
                        tracing::info!(executable = %candidate, filter = self.filter, "FFmpeg audio filter available");
                        return Ok(candidate);
                    }
                    Ok(result) => {
                        tracing::debug!(executable = %candidate, exit_code = ?result.exit_code, filter = self.filter, "FFmpeg filter probe failed");
                    }
                    Err(error) => {
                        tracing::debug!(executable = %candidate, %error, "FFmpeg candidate could not be checked");
                    }
                }
            }
            tracing::warn!(configured = ?self.configured, filter = self.filter, "FFmpeg is unavailable for audio analysis");
            Err(format!(
                "FFmpeg with the {} filter is unavailable. Check the server installation and FFMPEG_PATH.",
                self.filter
            ))
        }).await?;
        Ok(binary.as_str())
    }
}

fn configured_ffmpeg(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn ffmpeg_candidates(configured: Option<&str>, home: Option<&Path>) -> Vec<String> {
    if let Some(configured) = configured {
        return vec![configured.to_owned()];
    }

    let mut candidates = vec![String::from("ffmpeg")];
    #[cfg(windows)]
    let standard_paths = [r"C:\ffmpeg\bin\ffmpeg.exe"];
    #[cfg(not(windows))]
    let standard_paths = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
    candidates.extend(standard_paths.into_iter().map(str::to_owned));
    if let Some(home) = home {
        let executable = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        candidates.push(
            home.join(".spotdl")
                .join(executable)
                .to_string_lossy()
                .into_owned(),
        );
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_resolution_accepts_blank_and_quoted_overrides() {
        assert_eq!(configured_ffmpeg("   "), None);
        assert_eq!(configured_ffmpeg(r#" "" "#), None);
        let home = Path::new("service-account-home");
        let configured = configured_ffmpeg(r#"  "/opt/Media Tools/ffmpeg"  "#);
        assert_eq!(
            ffmpeg_candidates(configured.as_deref(), Some(home)),
            vec!["/opt/Media Tools/ffmpeg"]
        );

        let candidates = ffmpeg_candidates(None, Some(home));
        assert_eq!(candidates[0], "ffmpeg");
        let executable = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        assert!(
            candidates.contains(
                &home
                    .join(".spotdl")
                    .join(executable)
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }
}

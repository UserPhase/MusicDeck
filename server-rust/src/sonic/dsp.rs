//! # 128-Dimensional Sonic DSP Feature Extractor & FFmpeg PCM Decoder (`sonic::dsp`)
//!
//! Ports `server/src/tasks/runners/sonicFeatureWorker.ts` and the FFmpeg decoding
//! pipeline from `server/src/tasks/runners/sonicAnalysisRunner.ts`:
//! - [`fft`]: In-place Radix-2 Cooley-Tukey decimation-in-time FFT (`FFT_SIZE = 1024`)
//! - [`extract_sonic_features`]: Computes a 128-dimensional acoustic embedding:
//!   - `32` cepstral dimensions (mean + std dev of 16 DCT-II mel-cepstral coefficients)
//!   - `48` mel-filterbank dimensions (mean + std dev of 24 triangular mel bands)
//!   - `24` pitch-class chroma dimensions (mean + std dev of 12 semitone bins, `55..=4000 Hz`)
//!   - `16` rhythm autocorrelation lag dimensions (`55..=205 BPM` in `10 BPM` steps)
//!   - `8` spectral shape dimensions (mean + std dev of centroid, spread, 85% rolloff, and flux)
//! - [`encode_unit_vector`] & [`decode_unit_vector`]: L2-normalizes the 128-float vector
//!   and encodes it as a `512`-byte little-endian IEEE 754 `f32` BLOB for SQLite storage.

use std::f64::consts::PI;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// Target mono PCM sample rate used for Sonic DSP feature extraction (`12,000 Hz`).
pub const SONIC_SAMPLE_RATE: usize = 12_000;
/// FFT frame window length (`1,024` samples).
pub const FFT_SIZE: usize = 1024;
/// STFT hop stride (`256` samples).
pub const HOP: usize = 256;
/// Number of triangular mel-filterbank bands (`24`).
pub const BANDS: usize = 24;
/// Number of unique positive-frequency bins (`FFT_SIZE / 2 + 1 = 513`).
pub const BINS: usize = FFT_SIZE / 2 + 1;
/// Total dimensionality of a Sonic feature vector (`128`).
pub const SONIC_DIMENSIONS: usize = 128;
/// Maximum audio excerpt duration decoded per track (`30 seconds`).
pub const SAMPLE_SECONDS: usize = 30;
/// Maximum raw `s16le` PCM byte buffer size (`30 * 12,000 * 2 = 720,000 bytes`).
pub const PCM_BYTES: usize = SAMPLE_SECONDS * SONIC_SAMPLE_RATE * 2;
/// Task identifier for background Sonic audio analysis (`"SONIC_AUDIO_ANALYSIS"`).
pub const SONIC_TASK: &str = "SONIC_AUDIO_ANALYSIS";

/// Executes an in-place Radix-2 Cooley-Tukey FFT over `real` and `imaginary` slices of length [`FFT_SIZE`].
pub fn fft(real: &mut [f64; FFT_SIZE], imaginary: &mut [f64; FFT_SIZE]) {
    let mut reverse = 0_usize;
    for index in 1..FFT_SIZE {
        let mut bit = FFT_SIZE >> 1;
        while (reverse & bit) != 0 {
            reverse ^= bit;
            bit >>= 1;
        }
        reverse ^= bit;
        if index < reverse {
            real.swap(index, reverse);
            imaginary.swap(index, reverse);
        }
    }

    let mut size = 2_usize;
    while size <= FFT_SIZE {
        let half = size / 2;
        let angle = -2.0 * PI / (size as f64);
        let step_real = angle.cos();
        let step_imag = angle.sin();

        let mut offset = 0_usize;
        while offset < FFT_SIZE {
            let mut cosine = 1.0_f64;
            let mut sine = 0.0_f64;
            for position in offset..(offset + half) {
                let opposite = position + half;
                let x = real[opposite] * cosine - imaginary[opposite] * sine;
                let y = real[opposite] * sine + imaginary[opposite] * cosine;
                real[opposite] = real[position] - x;
                imaginary[opposite] = imaginary[position] - y;
                real[position] += x;
                imaginary[position] += y;

                let next_cosine = cosine * step_real - sine * step_imag;
                sine = cosine * step_imag + sine * step_real;
                cosine = next_cosine;
            }
            offset += size;
        }
        size *= 2;
    }
}

#[inline]
fn hz_to_mel(frequency_hz: f64) -> f64 {
    2595.0 * (1.0 + frequency_hz / 700.0).log10()
}

/// Extracts a 128-dimensional acoustic feature vector from normalized `[-1.0, 1.0]` mono `12 kHz` PCM samples.
///
/// Mirrors `extractSonicFeatures` in `server/src/tasks/runners/sonicFeatureWorker.ts`.
pub fn extract_sonic_features(samples: &[f32]) -> Result<[f32; SONIC_DIMENSIONS], String> {
    if samples.len() < FFT_SIZE {
        return Err(String::from(
            "Audio sample is silent or too short for sonic analysis.",
        ));
    }

    let mut window = [0.0_f64; FFT_SIZE];
    for (i, w) in window.iter_mut().enumerate() {
        *w = 0.5 - 0.5 * (2.0 * PI * (i as f64) / ((FFT_SIZE - 1) as f64)).cos();
    }

    let top_mel = hz_to_mel((SONIC_SAMPLE_RATE as f64) / 2.0);
    let mut weights = vec![[0.0_f64; BINS]; BANDS];
    for (band, weight_row) in weights.iter_mut().enumerate() {
        for (bin, w) in weight_row.iter_mut().enumerate() {
            let freq = (bin * SONIC_SAMPLE_RATE) as f64 / (FFT_SIZE as f64);
            let pos = hz_to_mel(freq) * ((BANDS + 1) as f64) / top_mel;
            *w = (1.0 - (pos - (band as f64) - 1.0).abs()).max(0.0);
        }
    }

    let mut chroma_bins = [-1_i8; BINS];
    for (bin, c_bin) in chroma_bins.iter_mut().enumerate() {
        let freq = (bin * SONIC_SAMPLE_RATE) as f64 / (FFT_SIZE as f64);
        if (55.0..=4000.0).contains(&freq) {
            let midi = (69.0 + 12.0 * (freq / 440.0).log2()).round() as i32;
            *c_bin = ((midi + 120) % 12) as i8;
        }
    }

    let mut dct = [[0.0_f64; BANDS]; 16];
    for (idx, row) in dct.iter_mut().enumerate() {
        for (band, coeff) in row.iter_mut().enumerate() {
            *coeff = (PI * ((idx + 1) as f64) * ((band as f64) + 0.5) / (BANDS as f64)).cos();
        }
    }

    let mut real = [0.0_f64; FFT_SIZE];
    let mut imaginary = [0.0_f64; FFT_SIZE];
    let mut previous = [0.0_f64; BINS];
    let mut power = [0.0_f64; BINS];
    let mut sums = [0.0_f64; 56];
    let mut squares = [0.0_f64; 56];
    let mut envelope: Vec<f64> = Vec::with_capacity(samples.len() / HOP);
    let mut frames = 0_usize;

    let mut start = 0_usize;
    while start + FFT_SIZE <= samples.len() {
        imaginary.fill(0.0);
        for i in 0..FFT_SIZE {
            real[i] = f64::from(samples[start + i]) * window[i];
        }
        fft(&mut real, &mut imaginary);

        let mut energy = 0.0_f64;
        for bin in 1..BINS {
            power[bin] = real[bin].powi(2) + imaginary[bin].powi(2);
            energy += power[bin];
        }

        if energy < 0.0001 {
            envelope.push(0.0);
            previous.fill(0.0);
            start += HOP;
            continue;
        }

        let mut chroma = [0.0_f64; 12];
        let mut centroid = 0.0_f64;
        let mut second_moment = 0.0_f64;
        let mut rolloff = 0.0_f64;
        let mut cumulative = 0.0_f64;
        let mut flux = 0.0_f64;

        for bin in 1..BINS {
            power[bin] /= energy;
            let frequency = (bin as f64) / ((BINS - 1) as f64);
            centroid += frequency * power[bin];
            second_moment += frequency.powi(2) * power[bin];
            cumulative += power[bin];
            if rolloff == 0.0 && cumulative >= 0.85 {
                rolloff = frequency;
            }
            let amplitude = power[bin].sqrt();
            flux += (amplitude - previous[bin]).max(0.0).powi(2);
            previous[bin] = amplitude;
            let c_idx = chroma_bins[bin];
            if c_idx >= 0 {
                chroma[c_idx as usize] += power[bin];
            }
        }

        let mut bands = [0.0_f64; BANDS];
        for (b_idx, weight_row) in weights.iter().enumerate() {
            let mut val = 0.0_f64;
            for bin in 1..BINS {
                val += weight_row[bin] * power[bin];
            }
            bands[b_idx] = (val + 1e-6).ln();
        }

        let mut cepstra = [0.0_f64; 16];
        for (c_idx, coeffs) in dct.iter().enumerate() {
            let mut sum = 0.0_f64;
            for band in 0..BANDS {
                sum += bands[band] * coeffs[band];
            }
            cepstra[c_idx] = (sum / (BANDS as f64)).tanh();
        }

        let chroma_total = {
            let s: f64 = chroma.iter().sum();
            if s > 0.0 { s } else { 1.0 }
        };

        let mut descriptors = [0.0_f64; 56];
        descriptors[0..16].copy_from_slice(&cepstra);
        for (i, &b) in bands.iter().enumerate() {
            descriptors[16 + i] = (b / 4.0).exp();
        }
        for (i, &c) in chroma.iter().enumerate() {
            descriptors[40 + i] = (c / chroma_total).sqrt();
        }
        descriptors[52] = centroid;
        descriptors[53] = (second_moment - centroid.powi(2)).max(0.0).sqrt();
        descriptors[54] = rolloff;
        descriptors[55] = flux.sqrt();

        for (i, &val) in descriptors.iter().enumerate() {
            sums[i] += val;
            squares[i] += val.powi(2);
        }

        envelope.push(flux.sqrt());
        frames += 1;
        start += HOP;
    }

    if frames < 8 {
        return Err(String::from(
            "Audio sample is silent or too short for sonic analysis.",
        ));
    }

    let frames_f = frames as f64;
    let moments = |range: std::ops::Range<usize>, out: &mut Vec<f32>| {
        for idx in range {
            let mean = sums[idx] / frames_f;
            let std_dev = (squares[idx] / frames_f - mean.powi(2)).max(0.0).sqrt();
            out.push(mean as f32);
            out.push(std_dev as f32);
        }
    };

    let env_mean = envelope.iter().sum::<f64>() / (envelope.len() as f64);
    let mut rhythm = [0.0_f32; 16];
    for (idx, r_out) in rhythm.iter_mut().enumerate() {
        let bpm = 55.0 + (idx as f64) * 10.0;
        let lag = ((60.0 * (SONIC_SAMPLE_RATE as f64)) / ((HOP as f64) * bpm)).round() as usize;
        let mut cross = 0.0_f64;
        let mut left = 0.0_f64;
        let mut right = 0.0_f64;
        for frame in lag..envelope.len() {
            let a = envelope[frame] - env_mean;
            let b = envelope[frame - lag] - env_mean;
            cross += a * b;
            left += a.powi(2);
            right += b.powi(2);
        }
        let denom = (left * right).sqrt();
        let val = if denom > 0.0 { cross / denom } else { 0.0 };
        *r_out = val.max(0.0) as f32;
    }

    let mut flat = Vec::with_capacity(SONIC_DIMENSIONS);
    moments(0..16, &mut flat);
    moments(16..40, &mut flat);
    moments(40..52, &mut flat);
    flat.extend_from_slice(&rhythm);
    moments(52..56, &mut flat);

    let mut output = [0.0_f32; SONIC_DIMENSIONS];
    output.copy_from_slice(&flat[..SONIC_DIMENSIONS]);
    Ok(output)
}

/// Validates and L2-normalizes a 128-dimensional feature vector, encoding it as a 512-byte little-endian BLOB.
pub fn encode_unit_vector(features: &[f32; SONIC_DIMENSIONS]) -> Result<Vec<u8>, String> {
    if !features.iter().all(|v| v.is_finite()) {
        return Err(String::from("Invalid sonic feature vector"));
    }
    let sum_sq: f64 = features.iter().map(|&v| f64::from(v).powi(2)).sum();
    let norm = sum_sq.sqrt();
    if norm <= 0.0 || !norm.is_finite() {
        return Err(String::from("Sonic feature vector has zero length"));
    }

    let mut buf = Vec::with_capacity(SONIC_DIMENSIONS * 4);
    for &val in features {
        let normalized = (f64::from(val) / norm) as f32;
        buf.extend_from_slice(&normalized.to_le_bytes());
    }
    Ok(buf)
}

/// Decodes a 512-byte little-endian BLOB from `sonic_vectors.vector` into `[f64; SONIC_DIMENSIONS]`.
#[must_use]
pub fn decode_unit_vector(bytes: &[u8]) -> Option<[f64; SONIC_DIMENSIONS]> {
    if bytes.len() != SONIC_DIMENSIONS * 4 {
        return None;
    }
    let mut out = [0.0_f64; SONIC_DIMENSIONS];
    for (i, slot) in out.iter_mut().enumerate() {
        let offset = i * 4;
        let arr: [u8; 4] = bytes[offset..offset + 4].try_into().ok()?;
        let val = f32::from_le_bytes(arr);
        if !val.is_finite() {
            return None;
        }
        *slot = f64::from(val);
    }
    Some(out)
}

/// Computes the exact cosine similarity ($\mathbf{u} \cdot \mathbf{v} \in [-1.0, 1.0]$) between two L2-normalized vectors.
#[must_use]
pub fn unit_cosine_similarity(
    left: &[f64; SONIC_DIMENSIONS],
    right: &[f64; SONIC_DIMENSIONS],
) -> Option<f64> {
    let dot: f64 = left.iter().zip(right.iter()).map(|(a, b)| a * b).sum();
    dot.is_finite().then(|| dot.clamp(-1.0, 1.0))
}

/// Decodes up to 30 seconds of mono 12 kHz `s16le` PCM from `file_path` via FFmpeg and extracts
/// the 128-dimensional Sonic feature vector on a background blocking thread.
pub async fn analyze_audio_file(
    file_path: &Path,
    ffmpeg_bin: &str,
    threads: u8,
) -> Result<[f32; SONIC_DIMENSIONS], String> {
    let raw_bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("Could not read audio file: {e}"))?;

    let thread_str = threads.clamp(1, 4).to_string();
    let sample_secs_str = SAMPLE_SECONDS.to_string();
    let sample_rate_str = SONIC_SAMPLE_RATE.to_string();

    let mut child = Command::new(ffmpeg_bin)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "pipe",
            "-threads",
            &thread_str,
            "-filter_threads",
            &thread_str,
            "-probesize",
            "2000000",
            "-analyzeduration",
            "2000000",
            "-i",
            "pipe:0",
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-t",
            &sample_secs_str,
            "-ar",
            &sample_rate_str,
            "-ac",
            "1",
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            String::from("FFmpeg is unavailable. Install it or configure FFMPEG_PATH.")
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(&raw_bytes).await;
            let _ = stdin.shutdown().await;
        });
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| String::from("FFmpeg stdout unavailable"))?;

    let read_future = async {
        let mut pcm = Vec::with_capacity(65_536);
        let mut chunk = [0_u8; 8192];
        loop {
            let n = stdout
                .read(&mut chunk)
                .await
                .map_err(|_| String::from("FFmpeg read error"))?;
            if n == 0 {
                break;
            }
            if pcm.len().saturating_add(n) > PCM_BYTES {
                return Err(String::from("Decoder exceeded the sonic sample limit."));
            }
            pcm.extend_from_slice(&chunk[..n]);
        }
        let status = child
            .wait()
            .await
            .map_err(|_| String::from("FFmpeg process wait failed"))?;
        if !status.success() || pcm.len() < 2048 || pcm.len() % 2 != 0 {
            return Err(String::from(
                "FFmpeg could not decode a supported audio sample.",
            ));
        }
        Ok(pcm)
    };

    let pcm_bytes = tokio::time::timeout(Duration::from_secs(30), read_future)
        .await
        .map_err(|_| String::from("Sonic decoding timed out."))??;

    tokio::task::spawn_blocking(move || {
        let samples: Vec<f32> = pcm_bytes
            .chunks_exact(2)
            .map(|pair| {
                let s = i16::from_le_bytes([pair[0], pair[1]]);
                f32::from(s) / 32768.0
            })
            .collect();
        extract_sonic_features(&samples)
    })
    .await
    .map_err(|_| String::from("Sonic feature worker panicked."))?
}

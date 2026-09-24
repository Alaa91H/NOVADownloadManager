use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaProcessingControl {
    Continue,
    Pause,
    Cancel,
}


#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaProcessingPhase {
    Planning,
    Probing,
    Demuxing,
    Decoding,
    Filtering,
    Encoding,
    Muxing,
    Finalizing,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaProcessingProgress {
    pub phase: MediaProcessingPhase,
    pub completed_units: u64,
    pub total_units: Option<u64>,
    pub fraction: Option<f32>,
    pub message: Option<String>,
}

impl MediaProcessingProgress {
    pub fn new(phase: MediaProcessingPhase) -> Self {
        Self {
            phase,
            completed_units: 0,
            total_units: None,
            fraction: None,
            message: None,
        }
    }
}

pub trait MediaProgressSink: Send + Sync {
    fn publish(&self, progress: &MediaProcessingProgress);
}

impl<F> MediaProgressSink for F
where
    F: Fn(&MediaProcessingProgress) + Send + Sync,
{
    fn publish(&self, progress: &MediaProcessingProgress) {
        self(progress);
    }
}

use thiserror::Error;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum MediaProcessingError {
    #[error("invalid native media processing job: {0}")]
    InvalidJob(String),
    #[error("unsupported native media container: {0}")]
    UnsupportedContainer(String),
    #[error("unsupported native media codec: {0}")]
    UnsupportedCodec(String),
    #[error("unsupported native media operation: {0}")]
    UnsupportedOperation(String),
    #[error("native media probe failed: {0}")]
    Probe(String),
    #[error("native media demux failed: {0}")]
    Demux(String),
    #[error("native media mux failed: {0}")]
    Mux(String),
    #[error("native media processing I/O failed: {0}")]
    Io(String),
    #[error("native media processing was cancelled")]
    Cancelled,
}

use crate::daemon::state::SharedState;
use crate::daemon::types::CreateDownloadBody;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct ValidateError(pub String);

impl std::fmt::Display for ValidateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct EngineStatus {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub features: Vec<String>,
}

pub trait Extractor: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn can_handle(&self, url: &str, has_media_options: bool) -> bool;
    fn validate(&self, body: &CreateDownloadBody) -> Result<(), ValidateError>;

    /// Whether the registry may try a lower-priority extractor after this
    /// extractor accepts the request shape but rejects its options.
    ///
    /// Native first-party engines can disable this to enforce fail-closed
    /// ownership and prevent silent delegation to compatibility executables.
    fn allow_validation_fallback(&self) -> bool {
        true
    }

    fn engine_status(&self, state: &SharedState) -> EngineStatus;
}

pub struct ExtractorRegistry {
    extractors: Vec<Arc<dyn Extractor>>,
}

impl ExtractorRegistry {
    pub fn new() -> Self {
        Self {
            extractors: Vec::new(),
        }
    }

    pub fn register(&mut self, extractor: Arc<dyn Extractor>) {
        self.extractors.push(extractor);
    }

    pub fn select(&self, url: &str, has_media_options: bool) -> Option<Arc<dyn Extractor>> {
        self.extractors
            .iter()
            .find(|e| e.can_handle(url, has_media_options))
            .cloned()
    }

    pub fn all(&self) -> Vec<Arc<dyn Extractor>> {
        self.extractors.clone()
    }

    /// Replaces an extractor in place, preserving the registry order used for
    /// selection. Managed external-tool installation uses this to activate a
    /// newly verified media-bridge binary without a daemon restart.
    pub fn replace(&mut self, id: &str, replacement: Arc<dyn Extractor>) -> bool {
        if let Some(existing) = self
            .extractors
            .iter_mut()
            .find(|extractor| extractor.id() == id)
        {
            *existing = replacement;
            true
        } else {
            false
        }
    }

    pub fn validate(&self, body: &CreateDownloadBody) -> Result<Arc<dyn Extractor>, ValidateError> {
        let has_media = body.media_options.is_some();
        let url = body.url.as_deref().unwrap_or("");
        let mut validation_errors = Vec::new();

        for extractor in self
            .extractors
            .iter()
            .filter(|extractor| extractor.can_handle(url, has_media))
        {
            match extractor.validate(body) {
                Ok(()) => return Ok(extractor.clone()),
                Err(error) => {
                    if !extractor.allow_validation_fallback() {
                        return Err(ValidateError(format!(
                            "{} rejected the request without fallback: {}",
                            extractor.id(),
                            error
                        )));
                    }
                    validation_errors.push(format!("{}: {}", extractor.id(), error));
                }
            }
        }

        if validation_errors.is_empty() {
            Err(ValidateError(format!("No extractor found for URL: {url}")))
        } else {
            Err(ValidateError(format!(
                "No compatible extractor accepted the request: {}",
                validation_errors.join("; ")
            )))
        }
    }
}

impl Default for ExtractorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct SharedExtractorRegistry(pub Arc<Mutex<ExtractorRegistry>>);

impl SharedExtractorRegistry {
    pub fn new(registry: ExtractorRegistry) -> Self {
        Self(Arc::new(Mutex::new(registry)))
    }

    pub fn validate(&self, body: &CreateDownloadBody) -> Result<Arc<dyn Extractor>, ValidateError> {
        self.0
            .lock()
            .map_err(|e| ValidateError(format!("Registry lock poisoned: {e}")))?
            .validate(body)
    }

    pub fn all(&self) -> Vec<Arc<dyn Extractor>> {
        self.0.lock().map(|r| r.all()).unwrap_or_default()
    }

    pub fn replace(
        &self,
        id: &str,
        replacement: Arc<dyn Extractor>,
    ) -> Result<bool, ValidateError> {
        let mut registry = self
            .0
            .lock()
            .map_err(|e| ValidateError(format!("Registry lock poisoned: {e}")))?;
        Ok(registry.replace(id, replacement))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockExtractor {
        id: String,
        media: bool,
    }
    impl Extractor for MockExtractor {
        fn id(&self) -> &str {
            &self.id
        }
        fn can_handle(&self, _url: &str, has_media: bool) -> bool {
            has_media == self.media
        }
        fn validate(&self, _body: &CreateDownloadBody) -> Result<(), ValidateError> {
            Ok(())
        }
        fn engine_status(&self, _state: &SharedState) -> EngineStatus {
            EngineStatus {
                id: self.id.clone(),
                name: self.id.clone(),
                available: true,
                version: None,
                features: vec![],
            }
        }
    }

    #[test]
    fn registry_selects_matching_extractor() {
        let mut reg = ExtractorRegistry::new();
        reg.register(Arc::new(MockExtractor {
            id: "curl".into(),
            media: false,
        }));
        reg.register(Arc::new(MockExtractor {
            id: "media-bridge".into(),
            media: true,
        }));

        assert!(reg.select("https://example.com/file.zip", false).is_some());
        assert_eq!(
            reg.select("https://example.com/file.zip", false)
                .unwrap()
                .id(),
            "curl"
        );

        assert!(reg
            .select("https://youtube.com/watch?v=123", true)
            .is_some());
        assert_eq!(
            reg.select("https://youtube.com/watch?v=123", true)
                .unwrap()
                .id(),
            "media-bridge"
        );
    }

    #[test]
    fn registry_select_returns_none_when_no_match() {
        let mut reg = ExtractorRegistry::new();
        reg.register(Arc::new(MockExtractor {
            id: "curl".into(),
            media: true,
        }));
        assert!(reg.select("https://example.com/file.zip", false).is_none());
    }

    #[test]
    fn registry_validate_selects_and_validates() {
        let mut reg = ExtractorRegistry::new();
        reg.register(Arc::new(MockExtractor {
            id: "curl".into(),
            media: false,
        }));
        let body = CreateDownloadBody {
            url: Some("https://example.com/file.zip".into()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: None,
            resumable: None,
            save_path: None,
            description: None,
            referer: None,
            start_immediately: None,
            direct_options: None,
            media_options: None,
        };
        let result = reg.validate(&body);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().id(), "curl");
    }

    struct RejectingExtractor;

    impl Extractor for RejectingExtractor {
        fn id(&self) -> &str {
            "native-first"
        }

        fn can_handle(&self, _url: &str, has_media: bool) -> bool {
            has_media
        }

        fn validate(&self, _body: &CreateDownloadBody) -> Result<(), ValidateError> {
            Err(ValidateError("unsupported native option".to_owned()))
        }

        fn allow_validation_fallback(&self) -> bool {
            false
        }

        fn engine_status(&self, _state: &SharedState) -> EngineStatus {
            EngineStatus {
                id: "native-first".to_owned(),
                name: "NOVA Media Engine".to_owned(),
                available: true,
                version: None,
                features: Vec::new(),
            }
        }
    }

    #[test]
    fn registry_fail_closed_extractor_blocks_compatibility_fallback() {
        let mut reg = ExtractorRegistry::new();
        reg.register(Arc::new(RejectingExtractor));
        reg.register(Arc::new(MockExtractor {
            id: "media-bridge".into(),
            media: true,
        }));
        let body = CreateDownloadBody {
            url: Some("https://example.com/video".into()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: None,
            resumable: None,
            save_path: None,
            description: None,
            referer: None,
            start_immediately: None,
            direct_options: None,
            media_options: Some(Default::default()),
        };

        let error = match reg.validate(&body) {
            Ok(selected) => panic!(
                "fail-closed extractor unexpectedly fell through to {}",
                selected.id()
            ),
            Err(error) => error,
        };
        assert!(error
            .to_string()
            .contains("native-first rejected the request without fallback"));
    }

    #[test]
    fn registry_validate_fails_when_no_match() {
        let reg = ExtractorRegistry::new();
        let body = CreateDownloadBody {
            url: Some("https://example.com/file.zip".into()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: None,
            resumable: None,
            save_path: None,
            description: None,
            referer: None,
            start_immediately: None,
            direct_options: None,
            media_options: None,
        };
        assert!(reg.validate(&body).is_err());
    }

    #[test]
    fn shared_registry_validate_works() {
        let mut reg = ExtractorRegistry::new();
        reg.register(Arc::new(MockExtractor {
            id: "curl".into(),
            media: false,
        }));
        let shared = SharedExtractorRegistry::new(reg);
        let body = CreateDownloadBody {
            url: Some("https://example.com/file.zip".into()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: None,
            resumable: None,
            save_path: None,
            description: None,
            referer: None,
            start_immediately: None,
            direct_options: None,
            media_options: None,
        };
        assert!(shared.validate(&body).is_ok());
    }

    #[test]
    fn registry_all_returns_all_extractors() {
        let mut reg = ExtractorRegistry::new();
        reg.register(Arc::new(MockExtractor {
            id: "a".into(),
            media: false,
        }));
        reg.register(Arc::new(MockExtractor {
            id: "b".into(),
            media: true,
        }));
        assert_eq!(reg.all().len(), 2);
    }
}

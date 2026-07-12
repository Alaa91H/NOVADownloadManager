use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CACHE_TTL_SECS: u64 = 3600;
const MAX_CACHE_ENTRIES: usize = 2048;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CachedMetadata {
    pub url: String,
    pub filename: String,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub accept_ranges: bool,
    pub checksum: Option<String>,
    pub headers: HashMap<String, String>,
    pub cached_at: String,
}

struct CacheEntry {
    metadata: CachedMetadata,
    inserted_at: Instant,
}

#[derive(Clone)]
pub struct MetadataCache {
    cache: Arc<Mutex<HashMap<String, CacheEntry>>>,
    ttl: Duration,
}

impl MetadataCache {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
            ttl: Duration::from_secs(CACHE_TTL_SECS),
        }
    }

    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
            ttl,
        }
    }

    pub fn get(&self, url: &str) -> Option<CachedMetadata> {
        self.cache.lock().ok().and_then(|cache| {
            cache.get(url).and_then(|entry| {
                if entry.inserted_at.elapsed() < self.ttl {
                    Some(entry.metadata.clone())
                } else {
                    None
                }
            })
        })
    }

    pub fn put(&self, metadata: CachedMetadata) {
        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= MAX_CACHE_ENTRIES {
                let evict_count = MAX_CACHE_ENTRIES / 4;
                let mut entries: Vec<_> = cache
                    .iter()
                    .map(|(k, v)| (k.clone(), v.inserted_at))
                    .collect();
                entries.sort_by_key(|(_, t)| *t);
                for (key, _) in entries.into_iter().take(evict_count) {
                    cache.remove(&key);
                }
            }
            cache.insert(
                metadata.url.clone(),
                CacheEntry {
                    metadata,
                    inserted_at: Instant::now(),
                },
            );
        }
    }

    pub fn remove(&self, url: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(url);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.clear();
        }
    }

    pub fn size(&self) -> usize {
        self.cache.lock().map(|c| c.len()).unwrap_or(0)
    }
}

impl Default for MetadataCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_returns_none_for_empty_cache() {
        let cache = MetadataCache::new();
        assert!(cache.get("https://example.com").is_none());
    }

    #[test]
    fn put_and_get_roundtrip() {
        let cache = MetadataCache::new();
        let meta = CachedMetadata {
            url: "https://example.com/file.zip".into(),
            filename: "file.zip".into(),
            content_type: Some("application/zip".into()),
            content_length: Some(1024),
            etag: None,
            last_modified: None,
            accept_ranges: true,
            checksum: None,
            headers: HashMap::new(),
            cached_at: "2026-01-01".into(),
        };
        cache.put(meta.clone());
        let got = cache.get("https://example.com/file.zip").unwrap();
        assert_eq!(got.filename, "file.zip");
        assert_eq!(got.content_length, Some(1024));
    }

    #[test]
    fn get_returns_none_for_expired_entry() {
        let cache = MetadataCache::with_ttl(Duration::from_millis(1));
        let meta = CachedMetadata {
            url: "https://example.com".into(),
            filename: "f".into(),
            content_type: None,
            content_length: None,
            etag: None,
            last_modified: None,
            accept_ranges: false,
            checksum: None,
            headers: HashMap::new(),
            cached_at: "".into(),
        };
        cache.put(meta);
        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get("https://example.com").is_none());
    }

    #[test]
    fn remove_deletes_entry() {
        let cache = MetadataCache::new();
        let meta = CachedMetadata {
            url: "https://example.com".into(),
            filename: "f".into(),
            content_type: None,
            content_length: None,
            etag: None,
            last_modified: None,
            accept_ranges: false,
            checksum: None,
            headers: HashMap::new(),
            cached_at: "".into(),
        };
        cache.put(meta);
        assert_eq!(cache.size(), 1);
        cache.remove("https://example.com");
        assert_eq!(cache.size(), 0);
    }

    #[test]
    fn clear_empties_cache() {
        let cache = MetadataCache::new();
        for i in 0..5 {
            let meta = CachedMetadata {
                url: format!("https://example.com/{}", i),
                filename: "f".into(),
                content_type: None,
                content_length: None,
                etag: None,
                last_modified: None,
                accept_ranges: false,
                checksum: None,
                headers: HashMap::new(),
                cached_at: "".into(),
            };
            cache.put(meta);
        }
        assert_eq!(cache.size(), 5);
        cache.clear();
        assert_eq!(cache.size(), 0);
    }

    #[test]
    fn eviction_triggers_at_max_entries() {
        let cache = MetadataCache::new();
        for i in 0..MAX_CACHE_ENTRIES + 10 {
            let meta = CachedMetadata {
                url: format!("https://example.com/{}", i),
                filename: "f".into(),
                content_type: None,
                content_length: None,
                etag: None,
                last_modified: None,
                accept_ranges: false,
                checksum: None,
                headers: HashMap::new(),
                cached_at: "".into(),
            };
            cache.put(meta);
        }
        let size = cache.size();
        assert!(
            size <= MAX_CACHE_ENTRIES,
            "cache size {} exceeds max {}",
            size,
            MAX_CACHE_ENTRIES
        );
    }
}

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: u32,
    pub conditions: Vec<RuleCondition>,
    pub action: RuleAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuleCondition {
    UrlMatches { pattern: String },
    UrlContains { text: String },
    UrlExtension { extensions: Vec<String> },
    FileSizeAbove { bytes: u64 },
    FileSizeBelow { bytes: u64 },
    HostnameEquals { hostname: String },
    HostnameContains { text: String },
    HeaderContains { header: String, value: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuleAction {
    SetCategory { category: String },
    SetPriority { priority: String },
    SetConnections { connections: u32 },
    SetSavePath { path: String },
    SetProfile { profile: String },
    SetRateLimit { kbps: u64 },
    AddHeader { name: String, value: String },
    AddMirror { url_pattern: String },
    RequireChecksum { algorithm: String },
    Reject { reason: String },
}

struct CompiledCondition {
    regex: Option<Regex>,
    condition: RuleCondition,
}

/// Rule id paired with its pre-compiled conditions.
type CompiledRule = (String, Vec<CompiledCondition>);

#[derive(Clone)]
pub struct DownloadRuleEngine {
    rules: Arc<Mutex<Vec<DownloadRule>>>,
    compiled: Arc<Mutex<Vec<CompiledRule>>>,
}

impl DownloadRuleEngine {
    pub fn new() -> Self {
        Self {
            rules: Arc::new(Mutex::new(Vec::new())),
            compiled: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn add_rule(&self, rule: DownloadRule) {
        let mut compiled_conditions = Vec::new();
        for cond in &rule.conditions {
            let regex = match cond {
                RuleCondition::UrlMatches { pattern } => Regex::new(pattern).ok(),
                _ => None,
            };
            compiled_conditions.push(CompiledCondition {
                regex,
                condition: cond.clone(),
            });
        }
        if let Ok(mut rules) = self.rules.lock() {
            rules.push(rule.clone());
            rules.sort_by_key(|r| r.priority);
        }
        if let Ok(mut compiled) = self.compiled.lock() {
            compiled.push((rule.id, compiled_conditions));
        }
    }

    pub fn remove_rule(&self, rule_id: &str) {
        if let Ok(mut rules) = self.rules.lock() {
            rules.retain(|r| r.id != rule_id);
        }
        if let Ok(mut compiled) = self.compiled.lock() {
            compiled.retain(|(id, _)| id != rule_id);
        }
    }

    /// Returns `(rule_id, action)` for every enabled rule whose conditions all match.
    pub fn evaluate(
        &self,
        url: &str,
        hostname: &str,
        size_bytes: Option<u64>,
    ) -> Vec<(String, RuleAction)> {
        self.evaluate_with_headers(url, hostname, size_bytes, &[])
    }

    /// Returns `(rule_id, action)` for every enabled rule whose conditions all match.
    /// `headers` provides response headers for `HeaderContains` condition evaluation.
    pub fn evaluate_with_headers(
        &self,
        url: &str,
        hostname: &str,
        size_bytes: Option<u64>,
        headers: &[(String, String)],
    ) -> Vec<(String, RuleAction)> {
        let rules = match self.rules.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        let compiled = match self.compiled.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };

        let mut actions = Vec::new();
        for (rule, (_, conditions)) in rules.iter().zip(compiled.iter()) {
            if !rule.enabled {
                continue;
            }
            let all_match = conditions.iter().all(|cc| match &cc.condition {
                RuleCondition::UrlMatches { .. } => cc
                    .regex
                    .as_ref()
                    .map(|re| re.is_match(url))
                    .unwrap_or(false),
                RuleCondition::UrlContains { text } => url.contains(text.as_str()),
                RuleCondition::UrlExtension { extensions } => {
                    let lower = url.to_lowercase();
                    extensions
                        .iter()
                        .any(|ext| lower.ends_with(&format!(".{}", ext)))
                }
                RuleCondition::FileSizeAbove { bytes } => {
                    size_bytes.map(|s| s > *bytes).unwrap_or(false)
                }
                RuleCondition::FileSizeBelow { bytes } => {
                    size_bytes.map(|s| s < *bytes).unwrap_or(false)
                }
                RuleCondition::HostnameEquals { hostname: h } => hostname.eq_ignore_ascii_case(h),
                RuleCondition::HostnameContains { text } => {
                    hostname.to_lowercase().contains(&text.to_lowercase())
                }
                RuleCondition::HeaderContains { header, value } => {
                    let header_lower = header.to_lowercase();
                    let value_lower = value.to_lowercase();
                    headers.iter().any(|(k, v)| {
                        k.to_lowercase().contains(&header_lower)
                            && v.to_lowercase().contains(&value_lower)
                    })
                }
            });
            if all_match {
                actions.push((rule.id.clone(), rule.action.clone()));
            }
        }
        actions
    }

    pub fn rules(&self) -> Vec<DownloadRule> {
        self.rules.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Default for DownloadRuleEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(
        id: &str,
        priority: u32,
        conditions: Vec<RuleCondition>,
        action: RuleAction,
    ) -> DownloadRule {
        DownloadRule {
            id: id.to_string(),
            name: format!("rule-{id}"),
            enabled: true,
            priority,
            conditions,
            action,
        }
    }

    fn reject_action(reason: &str) -> RuleAction {
        RuleAction::Reject {
            reason: reason.to_string(),
        }
    }

    // ------------------------------------------------------------------ 1
    #[test]
    fn empty_engine_returns_no_matches() {
        let engine = DownloadRuleEngine::new();
        let results = engine.evaluate("https://example.com/file.mp4", "example.com", Some(1024));
        assert!(results.is_empty());
    }

    // -------------------------------------------------------------- 2 & 3
    #[test]
    fn url_contains_matches() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlContains {
                text: "video".to_string(),
            }],
            reject_action("matched"),
        ));

        let results = engine.evaluate(
            "https://cdn.example.com/video/stream.mp4",
            "cdn.example.com",
            None,
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "r1");
    }

    #[test]
    fn url_contains_does_not_match() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlContains {
                text: "video".to_string(),
            }],
            reject_action("nope"),
        ));

        let results = engine.evaluate(
            "https://cdn.example.com/audio/stream.mp3",
            "cdn.example.com",
            None,
        );
        assert!(results.is_empty());
    }

    // ----------------------------------------------------------- 4 & 5
    #[test]
    fn url_matches_with_valid_regex() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlMatches {
                pattern: r"^https://.*\.example\.com/.*\.zip$".to_string(),
            }],
            reject_action("regex hit"),
        ));

        assert_eq!(
            engine
                .evaluate("https://dl.example.com/archive.zip", "dl.example.com", None)
                .len(),
            1
        );
        assert!(engine
            .evaluate(
                "https://dl.example.com/archive.tar.gz",
                "dl.example.com",
                None
            )
            .is_empty());
    }

    #[test]
    fn url_matches_with_invalid_regex_does_not_match() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlMatches {
                pattern: "[invalid".to_string(),
            }],
            reject_action("should never fire"),
        ));

        let results = engine.evaluate("https://example.com/anything", "example.com", None);
        assert!(results.is_empty());
    }

    // ----------------------------------------------------------- 6
    #[test]
    fn url_extension_matches_case_insensitive() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlExtension {
                extensions: vec!["mp4".to_string(), "zip".to_string()],
            }],
            reject_action("ext"),
        ));

        assert_eq!(
            engine.evaluate("https://x.com/f.mp4", "x.com", None).len(),
            1
        );
        assert_eq!(
            engine.evaluate("https://x.com/f.MP4", "x.com", None).len(),
            1
        );
        assert_eq!(
            engine.evaluate("https://x.com/f.ZIP", "x.com", None).len(),
            1
        );
        assert!(engine
            .evaluate("https://x.com/f.mkv", "x.com", None)
            .is_empty());
    }

    // ----------------------------------------------------------- 7 & 8
    #[test]
    fn file_size_above_matches() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::FileSizeAbove { bytes: 1000 }],
            reject_action("big"),
        ));

        assert_eq!(
            engine
                .evaluate("https://x.com/f", "x.com", Some(1001))
                .len(),
            1
        );
        assert!(engine
            .evaluate("https://x.com/f", "x.com", Some(999))
            .is_empty());
        assert!(engine
            .evaluate("https://x.com/f", "x.com", Some(1000))
            .is_empty());
    }

    #[test]
    fn file_size_below_matches() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::FileSizeBelow { bytes: 1000 }],
            reject_action("small"),
        ));

        assert_eq!(
            engine.evaluate("https://x.com/f", "x.com", Some(999)).len(),
            1
        );
        assert!(engine
            .evaluate("https://x.com/f", "x.com", Some(1000))
            .is_empty());
        assert!(engine
            .evaluate("https://x.com/f", "x.com", Some(1001))
            .is_empty());
    }

    #[test]
    fn file_size_conditions_with_none_size() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::FileSizeAbove { bytes: 0 }],
            reject_action("any"),
        ));
        assert!(engine.evaluate("https://x.com/f", "x.com", None).is_empty());
    }

    // ----------------------------------------------------------- 9 & 10
    #[test]
    fn hostname_equals_case_insensitive() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::HostnameEquals {
                hostname: "Example.Com".to_string(),
            }],
            reject_action("host"),
        ));

        assert_eq!(
            engine
                .evaluate("https://example.com/f", "example.com", None)
                .len(),
            1
        );
        assert_eq!(
            engine
                .evaluate("https://EXAMPLE.COM/f", "EXAMPLE.COM", None)
                .len(),
            1
        );
        assert!(engine
            .evaluate("https://other.com/f", "other.com", None)
            .is_empty());
    }

    #[test]
    fn hostname_contains() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::HostnameContains {
                text: "cdn".to_string(),
            }],
            reject_action("cdn"),
        ));

        assert_eq!(
            engine
                .evaluate("https://cdn.example.com/f", "cdn.example.com", None)
                .len(),
            1
        );
        assert_eq!(
            engine
                .evaluate("https://CDN.example.com/f", "CDN.example.com", None)
                .len(),
            1
        );
        assert!(engine
            .evaluate("https://api.example.com/f", "api.example.com", None)
            .is_empty());
    }

    // ----------------------------------------------------------- 11
    #[test]
    fn header_contains_no_match_without_headers() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::HeaderContains {
                header: "Content-Type".to_string(),
                value: "video".to_string(),
            }],
            reject_action("header"),
        ));

        assert!(engine.evaluate("https://x.com/f", "x.com", None).is_empty());
    }

    #[test]
    fn header_contains_matches_with_matching_headers() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::HeaderContains {
                header: "Content-Type".to_string(),
                value: "video".to_string(),
            }],
            reject_action("header"),
        ));

        let headers = vec![
            ("Content-Type".to_string(), "video/mp4".to_string()),
            ("Content-Length".to_string(), "1024".to_string()),
        ];
        assert_eq!(
            engine
                .evaluate_with_headers("https://x.com/f", "x.com", None, &headers)
                .len(),
            1
        );
    }

    #[test]
    fn header_contains_no_match_with_non_matching_headers() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::HeaderContains {
                header: "Content-Type".to_string(),
                value: "video".to_string(),
            }],
            reject_action("header"),
        ));

        let headers = vec![("Content-Type".to_string(), "text/html".to_string())];
        assert!(engine
            .evaluate_with_headers("https://x.com/f", "x.com", None, &headers)
            .is_empty());
    }

    // ----------------------------------------------------------- 12
    #[test]
    fn disabled_rule_not_evaluated() {
        let engine = DownloadRuleEngine::new();
        let mut rule = make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlContains {
                text: "match".to_string(),
            }],
            reject_action("should not fire"),
        );
        rule.enabled = false;
        engine.add_rule(rule);

        let results = engine.evaluate("https://x.com/match", "x.com", None);
        assert!(results.is_empty());
    }

    // ----------------------------------------------------------- 13
    #[test]
    fn multiple_conditions_all_must_match() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![
                RuleCondition::UrlContains {
                    text: "video".to_string(),
                },
                RuleCondition::HostnameEquals {
                    hostname: "cdn.example.com".to_string(),
                },
                RuleCondition::FileSizeAbove { bytes: 5_000_000 },
            ],
            reject_action("all"),
        ));

        // all three match
        assert_eq!(
            engine
                .evaluate(
                    "https://cdn.example.com/video.mp4",
                    "cdn.example.com",
                    Some(6_000_000)
                )
                .len(),
            1
        );

        // hostname wrong
        assert!(engine
            .evaluate("https://other.com/video.mp4", "other.com", Some(6_000_000))
            .is_empty());

        // size too small
        assert!(engine
            .evaluate(
                "https://cdn.example.com/video.mp4",
                "cdn.example.com",
                Some(100)
            )
            .is_empty());
    }

    // ----------------------------------------------------------- 14
    #[test]
    fn multiple_rules_evaluated_in_priority_order() {
        let engine = DownloadRuleEngine::new();

        engine.add_rule(make_rule(
            "high",
            100,
            vec![RuleCondition::UrlContains {
                text: "test".to_string(),
            }],
            reject_action("high-pri"),
        ));
        engine.add_rule(make_rule(
            "low",
            1,
            vec![RuleCondition::UrlContains {
                text: "test".to_string(),
            }],
            reject_action("low-pri"),
        ));

        let results = engine.evaluate("https://x.com/test", "x.com", None);
        assert_eq!(results.len(), 2);
        // sorted by priority ascending: low (1) first, high (100) second
        assert_eq!(results[0].0, "low");
        assert_eq!(results[1].0, "high");
    }

    // ----------------------------------------------------------- 15
    #[test]
    fn remove_rule_removes_matches() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlContains {
                text: "test".to_string(),
            }],
            reject_action("gone"),
        ));

        assert_eq!(
            engine.evaluate("https://x.com/test", "x.com", None).len(),
            1
        );

        engine.remove_rule("r1");
        assert!(engine
            .evaluate("https://x.com/test", "x.com", None)
            .is_empty());
    }

    // ----------------------------------------------------------- 16
    #[test]
    fn multiple_matching_rules_all_returned() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "a",
            10,
            vec![RuleCondition::UrlContains {
                text: "file".to_string(),
            }],
            reject_action("a"),
        ));
        engine.add_rule(make_rule(
            "b",
            20,
            vec![RuleCondition::HostnameContains {
                text: "example".to_string(),
            }],
            reject_action("b"),
        ));
        engine.add_rule(make_rule(
            "c",
            30,
            vec![RuleCondition::UrlExtension {
                extensions: vec!["mp4".to_string()],
            }],
            reject_action("c"),
        ));

        let results = engine.evaluate("https://example.com/file.mp4", "example.com", None);
        assert_eq!(results.len(), 3);
        let ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"));
        assert!(ids.contains(&"c"));
    }

    // ----------------------------------------------------------- extras
    #[test]
    fn rules_method_returns_all_rules() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            1,
            vec![RuleCondition::UrlContains {
                text: "a".to_string(),
            }],
            reject_action("a"),
        ));
        engine.add_rule(make_rule(
            "r2",
            2,
            vec![RuleCondition::UrlContains {
                text: "b".to_string(),
            }],
            reject_action("b"),
        ));

        let all = engine.rules();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn remove_nonexistent_rule_is_noop() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlContains {
                text: "x".to_string(),
            }],
            reject_action("x"),
        ));
        engine.remove_rule("does-not-exist");
        assert_eq!(engine.evaluate("https://x.com/x", "x.com", None).len(), 1);
    }

    #[test]
    fn no_conditions_means_always_match() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule("r1", 0, vec![], reject_action("always")));
        assert_eq!(engine.evaluate("https://x.com/f", "x.com", None).len(), 1);
    }

    #[test]
    fn url_extension_requires_dot_prefix() {
        let engine = DownloadRuleEngine::new();
        engine.add_rule(make_rule(
            "r1",
            0,
            vec![RuleCondition::UrlExtension {
                extensions: vec!["mp4".to_string()],
            }],
            reject_action("ext"),
        ));

        assert!(engine
            .evaluate("https://x.com/filemp4", "x.com", None)
            .is_empty());
    }
}

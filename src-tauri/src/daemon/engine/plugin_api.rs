use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub api_version: String,
    pub hooks: Vec<String>,
    pub settings: HashMap<String, PluginSetting>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginSetting {
    pub name: String,
    pub setting_type: String,
    pub default_value: serde_json::Value,
    pub description: String,
    pub required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginState {
    pub id: String,
    pub enabled: bool,
    pub settings: HashMap<String, serde_json::Value>,
    pub error: Option<String>,
}

struct PluginEntry {
    manifest: PluginManifest,
    state: PluginState,
}

#[derive(Clone)]
pub struct PluginApi {
    plugins: Arc<Mutex<Vec<PluginEntry>>>,
    api_version: String,
}

impl PluginApi {
    pub fn new() -> Self {
        Self {
            plugins: Arc::new(Mutex::new(Vec::new())),
            api_version: "1.0.0".to_string(),
        }
    }

    pub fn register_plugin(&self, manifest: PluginManifest) -> Result<(), String> {
        let state = PluginState {
            id: manifest.id.clone(),
            enabled: true,
            settings: manifest
                .settings
                .iter()
                .map(|(k, v)| (k.clone(), v.default_value.clone()))
                .collect(),
            error: None,
        };
        let entry = PluginEntry { manifest, state };
        let mut plugins = self
            .plugins
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if plugins.iter().any(|p| p.manifest.id == entry.manifest.id) {
            return Err("Plugin already registered".to_string());
        }
        plugins.push(entry);
        Ok(())
    }

    pub fn unregister_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self
            .plugins
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        let before = plugins.len();
        plugins.retain(|p| p.manifest.id != plugin_id);
        if plugins.len() == before {
            return Err("Plugin not found".to_string());
        }
        Ok(())
    }

    pub fn enable_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self
            .plugins
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if let Some(plugin) = plugins.iter_mut().find(|p| p.manifest.id == plugin_id) {
            plugin.state.enabled = true;
            plugin.state.error = None;
            Ok(())
        } else {
            Err("Plugin not found".to_string())
        }
    }

    pub fn disable_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self
            .plugins
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if let Some(plugin) = plugins.iter_mut().find(|p| p.manifest.id == plugin_id) {
            plugin.state.enabled = false;
            Ok(())
        } else {
            Err("Plugin not found".to_string())
        }
    }

    pub fn update_plugin_settings(
        &self,
        plugin_id: &str,
        settings: HashMap<String, serde_json::Value>,
    ) -> Result<(), String> {
        let mut plugins = self
            .plugins
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if let Some(plugin) = plugins.iter_mut().find(|p| p.manifest.id == plugin_id) {
            for (key, value) in settings {
                plugin.state.settings.insert(key, value);
            }
            Ok(())
        } else {
            Err("Plugin not found".to_string())
        }
    }

    pub fn list_plugins(&self) -> Vec<PluginInfo> {
        self.plugins
            .lock()
            .map(|plugins| {
                plugins
                    .iter()
                    .map(|p| PluginInfo {
                        manifest: p.manifest.clone(),
                        state: p.state.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_plugin(&self, plugin_id: &str) -> Option<PluginInfo> {
        self.plugins.lock().ok().and_then(|plugins| {
            plugins
                .iter()
                .find(|p| p.manifest.id == plugin_id)
                .map(|p| PluginInfo {
                    manifest: p.manifest.clone(),
                    state: p.state.clone(),
                })
        })
    }

    pub fn api_version(&self) -> &str {
        &self.api_version
    }
}

impl Default for PluginApi {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub state: PluginState,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_manifest(id: &str) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: format!("Plugin {}", id),
            version: "1.0.0".to_string(),
            description: "Test plugin".to_string(),
            author: "Test".to_string(),
            api_version: "1.0.0".to_string(),
            hooks: vec![],
            settings: HashMap::new(),
        }
    }

    #[test]
    fn register_and_list_plugin() {
        let api = PluginApi::new();
        api.register_plugin(make_manifest("p1")).unwrap();
        let plugins = api.list_plugins();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].manifest.id, "p1");
        assert!(plugins[0].state.enabled);
    }

    #[test]
    fn register_duplicate_plugin_fails() {
        let api = PluginApi::new();
        api.register_plugin(make_manifest("p1")).unwrap();
        assert!(api.register_plugin(make_manifest("p1")).is_err());
    }

    #[test]
    fn unregister_plugin() {
        let api = PluginApi::new();
        api.register_plugin(make_manifest("p1")).unwrap();
        api.unregister_plugin("p1").unwrap();
        assert!(api.list_plugins().is_empty());
    }

    #[test]
    fn unregister_nonexistent_plugin_fails() {
        let api = PluginApi::new();
        assert!(api.unregister_plugin("nope").is_err());
    }

    #[test]
    fn enable_disable_plugin() {
        let api = PluginApi::new();
        api.register_plugin(make_manifest("p1")).unwrap();
        api.disable_plugin("p1").unwrap();
        let info = api.get_plugin("p1").unwrap();
        assert!(!info.state.enabled);
        api.enable_plugin("p1").unwrap();
        let info = api.get_plugin("p1").unwrap();
        assert!(info.state.enabled);
        assert!(info.state.error.is_none());
    }

    #[test]
    fn enable_nonexistent_plugin_fails() {
        let api = PluginApi::new();
        assert!(api.enable_plugin("nope").is_err());
    }

    #[test]
    fn disable_nonexistent_plugin_fails() {
        let api = PluginApi::new();
        assert!(api.disable_plugin("nope").is_err());
    }

    #[test]
    fn update_plugin_settings() {
        let api = PluginApi::new();
        api.register_plugin(make_manifest("p1")).unwrap();
        let mut settings = HashMap::new();
        settings.insert("key".to_string(), serde_json::json!("value"));
        api.update_plugin_settings("p1", settings).unwrap();
        let info = api.get_plugin("p1").unwrap();
        assert_eq!(info.state.settings.get("key").unwrap(), "value");
    }

    #[test]
    fn update_settings_nonexistent_plugin_fails() {
        let api = PluginApi::new();
        let mut settings = HashMap::new();
        settings.insert("key".to_string(), serde_json::json!("value"));
        assert!(api.update_plugin_settings("nope", settings).is_err());
    }

    #[test]
    fn get_plugin_returns_none_for_unknown() {
        let api = PluginApi::new();
        assert!(api.get_plugin("nope").is_none());
    }

    #[test]
    fn api_version_returns_correct_value() {
        let api = PluginApi::new();
        assert_eq!(api.api_version(), "1.0.0");
    }
}

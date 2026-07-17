pub(crate) mod common;
pub(crate) mod diagnostics;
pub(crate) mod downloads;
pub(crate) mod engine;
pub(crate) mod extension;
pub(crate) mod external_tools;
pub(crate) mod probes;

use crate::daemon::state::SharedState;
use axum::Router;

pub(crate) use self::downloads::{handle_pause_task, handle_resume_task};

pub(crate) use self::engine::run_scheduler_tick;

pub(crate) use self::diagnostics::record_daemon_start;

pub(crate) fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    let router = downloads::register_routes(router);
    let router = engine::register_routes(router);
    let router = extension::register_routes(router);
    let router = external_tools::register_routes(router);
    let router = probes::register_routes(router);
    diagnostics::register_routes(router)
}

#[cfg(test)]
mod meta_refresh_tests {
    use crate::daemon::utils::{decode_html_entities, parse_meta_refresh_url};

    #[test]
    fn extracts_single_quoted_uppercase_url() {
        let html = r#"<html><head><meta http-equiv="refresh" content="5;URL='https://ftp.fau.de/videolan/vlc/3.0.23/win64/vlc-3.0.23-win64.exe'" /></head></html>"#;
        assert_eq!(
            parse_meta_refresh_url(html).as_deref(),
            Some("https://ftp.fau.de/videolan/vlc/3.0.23/win64/vlc-3.0.23-win64.exe")
        );
    }

    #[test]
    fn extracts_bare_url_and_decodes_entities() {
        let html = r#"<meta http-equiv="refresh" content="5; url=https://downloads.sourceforge.net/project/foo/bar.zip?ts=ABC&amp;use_mirror=altushost-swe&amp;r=">"#;
        assert_eq!(
            parse_meta_refresh_url(html).as_deref(),
            Some("https://downloads.sourceforge.net/project/foo/bar.zip?ts=ABC&use_mirror=altushost-swe&r=")
        );
    }

    #[test]
    fn decodes_common_entities() {
        let input = "a&amp;b&#38;c&#x26;d&quot;e&#39;f&lt;g&gt;h";
        assert_eq!(decode_html_entities(input), "a&b&c&d\"e'f<g>h");
    }
}

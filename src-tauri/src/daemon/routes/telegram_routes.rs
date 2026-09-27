use axum::routing::{get, post};
use axum::Router;

use crate::daemon::state::SharedState;
use crate::daemon::telegram::{
    handle_telegram_config, handle_telegram_send_file, handle_telegram_test,
    handle_telegram_update_config,
};

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route(
            "/api/telegram/config",
            get(handle_telegram_config).post(handle_telegram_update_config),
        )
        .route("/api/telegram/test", post(handle_telegram_test))
        .route("/api/telegram/send-file", post(handle_telegram_send_file))
}

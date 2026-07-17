#![windows_subsystem = "windows"]

fn main() {
    install_panic_hook();

    if nova_lib::is_native_messaging_launch() {
        nova_lib::run_native_messaging_host();
        return;
    }
    if nova_lib::is_integration_mode() {
        nova_lib::run_integration_mode();
        return;
    }
    nova_lib::run();
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<dyn Any>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        log::error!(
            "[PANIC] thread '{}' panicked at {}: {}",
            name,
            location,
            payload
        );
        default_hook(info);
    }));
}

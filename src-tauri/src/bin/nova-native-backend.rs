#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    nova_lib::logging::init_default();
    nova_lib::run_native_backend();
}

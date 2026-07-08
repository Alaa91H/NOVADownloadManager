#![windows_subsystem = "windows"]

fn main() {
    if nova_lib::is_native_messaging_launch() {
        nova_lib::run_native_messaging_host();
        return;
    }
    nova_lib::run();
}

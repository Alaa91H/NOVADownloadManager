# Store Compliance

Core permissions are storage, contextMenus, nativeMessaging, alarms, notifications. downloads, webRequest, scripting, tabs and broad host access are optional and feature-gated.

## PermissionPolicy implementation

The options UI exposes each optional permission with a user-facing reason and degraded-mode explanation. Missing `downloads` disables download interception only; missing `webRequest` disables header enrichment only; missing broad host access disables deep network capture while popup-activated scanning can still work where `scripting` and active tab access are available.

## Store review privacy and remote code statement

The production package must not use remote code, remote scripts, dynamic evaluation, or hosted executable resources. Privacy disclosures must describe local capture, optional permissions, diagnostics, and the absence of hidden telemetry.

# Permissions Documentation

## Optional Permissions
High-impact permissions are declared as optional to respect user privacy. The user is prompted for consent before `downloads`, `webRequest`, `scripting`, `tabs`, and `host_permissions` are activated. This ensures the extension works with minimal privileges by default.

## Host Access (`<all_urls>`)
Broad host access is declared as an optional permission. When denied, the extension falls back to active-tab scoped scanning. The user can grant or revoke `<all_urls>` access at any time through the extension settings or Chrome's permission UI.

## Downloads
The `downloads` permission enables the extension to intercept and manage download events. This permission is optional and only requested when the user enables download takeover features.

## WebRequest
The `webRequest` permission allows the extension to inspect and enrich network headers for media detection. This permission is optional and only activated when the user enables advanced network capture features.

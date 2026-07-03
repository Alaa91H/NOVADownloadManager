# Chrome Web Store Review Checklist

## Permissions
All permissions are declared with minimal scope. Optional permissions (`downloads`, `webRequest`, `scripting`, `tabs`) are requested only when the user activates the corresponding feature. Broad host access (`<all_urls>`) is optional and gated behind explicit user consent.

## Privacy
No user data is collected, transmitted, or shared. All processing happens locally on the device. The extension does not use any remote services, analytics, or telemetry. Diagnostic data is stored locally and can be cleared by the user at any time.

## Remote Code
The extension does not load or execute any remote code. All scripts are bundled in the package. Content Security Policy restricts script sources to `'self'`, forbids `unsafe-eval` and `unsafe-inline`, and locks down object, base-uri, and frame-ancestors.

## Compliance
This checklist ensures the extension meets Chrome Web Store review requirements for permission justification, privacy disclosure, and code integrity.

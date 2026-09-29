# NOVA desktop localization

The desktop interface owns its translations in `desktop-native/src/localization/I18nManager.cpp`. English and Arabic are the supported release languages; Arabic uses right-to-left layout. The browser extension has a separate localization system under `browser-extension/`.

When adding or changing a desktop message:

1. Update the English and Arabic dictionaries in `I18nManager.cpp` with the same key.
2. Preserve message placeholders and keep technical values readable in left-to-right order where appropriate.
3. Run `pnpm run native:check` after implementation is complete. This includes the localization consistency and release-language checks.
4. Build and launch the Qt application using [`desktop-native/README.md`](../../desktop-native/README.md), then review the message in both English and Arabic, including Arabic RTL layout.

Do not add desktop translations to a React locale tree. React localization belongs only to the browser extension.

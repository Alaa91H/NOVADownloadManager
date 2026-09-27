# NOVA Internationalization (i18n)

NOVA supports **35 interface languages** using a lazy-loaded chunk architecture. This document explains how translations are organized and how to add or update a language.

---

## Architecture

| File | Purpose |
|------|---------|
| `src/lib/i18n/index.ts` | Language registry and lazy loader |
| `src/lib/i18n/en.ts` | English — bundled synchronously as the default fallback |
| `src/lib/i18n/<locale>.ts` | All other locales — loaded on demand as separate chunks |

English is always bundled in the main application bundle to guarantee a synchronous fallback at startup. Every other language is loaded dynamically when the user selects it, keeping startup fast regardless of how many languages are supported.

---

## Adding a New Language

1. **Create the locale file**  
   Copy `src/lib/i18n/en.ts` to `src/lib/i18n/<locale>.ts` (use BCP 47 locale codes, e.g. `fr`, `zh-CN`, `pt-BR`).

2. **Translate all keys**  
   Replace every English value with the translated string. Keep the key names identical to English — the keys are never exposed to users.

3. **Register the locale**  
   Open `src/lib/i18n/index.ts` and add an entry to the `LANGUAGES` registry:
   ```ts
   { code: 'fr', name: 'Français', dir: 'ltr' },
   ```
   Then add a lazy loader to the `loadLocale` function:
   ```ts
   case 'fr': return import('./fr');
   ```

4. **Sync and validate**  
   ```bash
   pnpm run i18n:sync      # rebuilds the index of lazy loaders
   pnpm run i18n:validate  # checks all locales against the English key set
   ```
   The validate script will report:
   - Missing keys (keys in English but absent in the locale)
   - Extra keys (keys in the locale but not in English)
   - Empty string values

5. **Test the language**  
   Start the app with `pnpm run dev` and switch to the new language from Settings > Language.

---

## Updating Translations

When new UI strings are added to English, run:
```bash
pnpm run i18n:sync
pnpm run i18n:validate
```

The validate script will list which locales are missing the new keys. Update those locale files before committing.

---

## Translation Quality Guidelines

- Keep translations natural and idiomatic — avoid word-for-word literal translations.
- Respect RTL text direction for Arabic, Hebrew, Persian, and Urdu (the `dir: 'rtl'` flag in the registry controls layout mirroring).
- Preserve `{variable}` placeholders exactly as they appear in the English string.
- For numeric formatting, prefer the locale's natural convention (e.g. `1.234,56` vs `1,234.56`).
- Keep strings concise — NOVA's UI is space-constrained in compact density mode.

---

## Supported Languages (35)

| Code | Language | Direction |
|------|---------|-----------|
| `en` | English | LTR |
| `ar` | Arabic | RTL |
| `bn` | Bengali | LTR |
| `bg` | Bulgarian | LTR |
| `zh-CN` | Chinese (Simplified) | LTR |
| `zh-TW` | Chinese (Traditional) | LTR |
| `cs` | Czech | LTR |
| `da` | Danish | LTR |
| `nl` | Dutch | LTR |
| `fi` | Finnish | LTR |
| `fr` | French | LTR |
| `de` | German | LTR |
| `el` | Greek | LTR |
| `he` | Hebrew | RTL |
| `hi` | Hindi | LTR |
| `hu` | Hungarian | LTR |
| `id` | Indonesian | LTR |
| `it` | Italian | LTR |
| `ja` | Japanese | LTR |
| `ko` | Korean | LTR |
| `ms` | Malay | LTR |
| `no` | Norwegian | LTR |
| `fa` | Persian | RTL |
| `pl` | Polish | LTR |
| `pt` | Portuguese | LTR |
| `ro` | Romanian | LTR |
| `ru` | Russian | LTR |
| `sk` | Slovak | LTR |
| `es` | Spanish | LTR |
| `sv` | Swedish | LTR |
| `th` | Thai | LTR |
| `tr` | Turkish | LTR |
| `uk` | Ukrainian | LTR |
| `ur` | Urdu | RTL |
| `vi` | Vietnamese | LTR |

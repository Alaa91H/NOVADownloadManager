# NOVA design tokens

`nova-design-tokens.json` is the versioned source for the cross-platform visual
tokens. Edit that file, then run `node scripts/generate-design-tokens.mjs` to
regenerate the QML singleton and Compose constants. CI runs the generator with
`--check` and rejects stale generated files.

The shared palettes include light, dark and high-contrast variants. Android may
opt into Android 12+ dynamic colors as a user-facing personalization option;
otherwise its Compose theme consumes the shared palette. Desktop-specific
window geometry is kept in the same schema, while spacing, typography, radius,
motion and semantic icon IDs are shared across clients.

The token set is a foundation, not proof that every QML and Compose component
uses every token. New UI work should reference generated values instead of
adding literal design values to a platform component.

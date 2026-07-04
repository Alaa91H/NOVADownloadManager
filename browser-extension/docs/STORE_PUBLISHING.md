# Store Publishing Guide

## Build for Store
Run `pnpm build:store` to produce a store-compliant build. This command activates the store permission policy, which moves high-impact permissions (`downloads`, `webRequest`, `scripting`, `tabs`, `<all_urls>`) to optional, and restricts host permissions to loopback addresses.

## Release Process
After building, verify the package with `pnpm verify:store` and `pnpm audit:release`. The release must pass all preflight checks, offline audits, and the release submission audit before submission.

## Review Guidelines
Store review requires that all permission justifications are documented, privacy disclosures are accurate, and no remote code or eval is present. The `docs/STORE_REVIEW_CHECKLIST.md` provides a complete reference for the review process.

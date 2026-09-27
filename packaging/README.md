# Package manager distribution

On every tagged release, CI runs `pnpm run packaging:manifests` and attaches
generated manifests (under `packaging/` in the release assets) for:

- **Scoop** — `nova-download-manager.json`
- **Homebrew** (cask) — `nova-download-manager.rb`
- **winget** — `NOVA.DownloadManager.*.yaml` (3 files)

The manifests carry the real release URLs and SHA-256 hashes, so publishing is
just a matter of forwarding them to each package index:

## Scoop
1. Create/maintain a bucket repo (e.g. `Alaa91H/scoop-nova`).
2. Copy `nova-download-manager.json` into `bucket/` and push.
   Users then run `scoop bucket add nova https://github.com/Alaa91H/scoop-nova`
   and `scoop install nova-download-manager`.

## Homebrew (cask)
1. Create/maintain a tap repo (`Alaa91H/homebrew-nova`).
2. Copy `nova-download-manager.rb` into `Casks/` and push.
   Users then run `brew install --cask alaa91h/nova/nova-download-manager`.

## winget
1. Fork [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs).
2. Place the three YAML files under
   `manifests/n/NOVA/DownloadManager/<version>/` and open a PR.
   Validate first with `winget validate` / `wingetcreate`.

Auto-submission (opening these PRs from CI) needs a token with access to the
target repos; wire it into the publish job when ready.

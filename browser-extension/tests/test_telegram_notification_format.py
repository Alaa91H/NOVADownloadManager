from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_telegram_sender_uses_html_parse_mode_and_disables_previews() -> None:
    telegram = read('scripts/telegram-release-notify.py')

    assert 'DEFAULT_PARSE_MODE = "HTML"' in telegram
    assert 'payload_fields["parse_mode"] = parse_mode' in telegram
    assert '"disable_web_page_preview": "true"' in telegram
    assert 'html_escape(' in telegram
    assert 'truncate_message' in telegram


def test_release_notification_is_compact_html_with_named_download_links(tmp_path: Path) -> None:
    assets = tmp_path / 'assets'
    output = tmp_path / 'notes'
    assets.mkdir()
    (assets / 'release-manifest.json').write_text(
        '{"artifacts":[{"file":"Apex-Browser-Extension-chrome-2.0.8.0.zip"},'
        '{"file":"Apex-Browser-Extension-edge-2.0.8.0.zip"},'
        '{"file":"Apex-Browser-Extension-firefox-2.0.8.0.xpi"}]}',
        encoding='utf-8',
    )

    env = os.environ.copy()
    env.update(
        {
            'RELEASE_TAG': 'v2.0.8-beta',
            'EXT_VERSION': '2.0.8.0',
            'RELEASE_REPOSITORY': 'Alaa91H/ADM-extension',
            'RELEASE_ACTOR': 'Alaa91H',
            'RELEASE_URL': 'https://github.com/Alaa91H/ADM-extension/releases/tag/v2.0.8-beta',
            'RELEASE_DOWNLOAD_BASE': 'https://github.com/Alaa91H/ADM-extension/releases/download/v2.0.8-beta',
        }
    )
    result = subprocess.run(
        ['node', 'tools/prepare-release-notes.mjs', '--assets', str(assets), '--output', str(output)],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    message = (output / 'RELEASE_NOTIFICATION.txt').read_text(encoding='utf-8')

    assert '<b>NOVA Download Manager Extension</b>' in message
    assert '<code>v2.0.8-beta</code>' in message
    assert '<a href="https://github.com/Alaa91H/ADM-extension/releases/download/v2.0.8-beta/Apex-Browser-Extension-chrome-2.0.8.0.zip">Chrome ZIP</a>' in message
    assert '<a href="https://github.com/Alaa91H/ADM-extension/releases/download/v2.0.8-beta/Apex-Browser-Extension-edge-2.0.8.0.zip">Edge ZIP</a>' in message
    assert '<a href="https://github.com/Alaa91H/ADM-extension/releases/download/v2.0.8-beta/Apex-Browser-Extension-firefox-2.0.8.0.xpi">Firefox XPI</a>' in message
    assert '<a href="https://github.com/Alaa91H/ADM-extension/releases/download/v2.0.8-beta/release-manifest.json">Release manifest</a>' in message
    assert 'Apex-Browser-Extension-chrome-2.0.8.0.zip:' not in message
    assert 'Apex-Browser-Extension-edge-2.0.8.0.zip:' not in message
    assert 'Apex-Browser-Extension-firefox-2.0.8.0.xpi:' not in message

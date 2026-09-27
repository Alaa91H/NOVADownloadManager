#!/usr/bin/env bash
set -euo pipefail

base_url="${NOVA_ACCEPTANCE_BASE_URL:-http://127.0.0.1:3199}"
origin='chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej'

ping="$(curl --fail --silent --show-error --max-time 15 "${base_url}/v1/ping")"
printf '%s' "$ping" | grep -q '"protocolVersion":4'
printf '%s' "$ping" | grep -q '"browserIntegrationEnabled":true'

pair="$(curl --fail --silent --show-error --max-time 15 \
  -X POST "${base_url}/v1/pair/auto" \
  -H "Origin: ${origin}" \
  -H 'Content-Type: application/json' \
  --data '{"clientId":"real-extension-acceptance","protocolVersion":4,"extensionOrigin":"chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej/","trustedLocalOnly":true,"mode":"trusted-local-native-host","requireLocalhost":true,"allowUserPrompt":false,"silent":true,"zeroClick":true}')"
token="$(printf '%s' "$pair" | sed -n 's/.*"pairToken":"\([^"]*\)".*/\1/p')"
test -n "$token"

auth="$(curl --fail --silent --show-error --max-time 15 \
  -X POST "${base_url}/v1/auth/check" \
  -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/json' \
  --data '{}')"
printf '%s' "$auth" | grep -q '"ok":true'

handoff="$(curl --fail --silent --show-error --max-time 20 \
  -X POST "${base_url}/v1/add" \
  -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/json' \
  --data '{"idempotencyKey":"real-extension-acceptance-20260820","source":"nova-extension","candidate":{"id":"real-extension-acceptance","url":"https://example.com/nova-extension-acceptance.bin","finalUrl":"https://example.com/nova-extension-acceptance.bin","filename":"nova-extension-acceptance.bin","source":"dom","mediaType":"archive","confidence":95,"createdAt":"2026-08-20T00:00:00.000Z"}}')"
printf '%s' "$handoff" | grep -q '"ok":true'
printf '%s' "$handoff" | grep -q '"accepted":true'

printf '%s\n' 'Real extension loopback acceptance passed: ping, trusted pairing, bearer validation, and candidate handoff.'

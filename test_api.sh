#!/usr/bin/env bash
# test_api.sh — curl tests for facedocs.bond (works locally or remote)
BASE=${1:-https://facedocs.bond}
# use http://127.0.0.1:3000 if testing locally
echo "Testing against $BASE"

echo "== /api/health =="
curl -s "$BASE/api/health" | python3 -m json.tool

echo ""
echo "== POST /api/validate_key (NOWORNEVER) =="
curl -s -X POST "$BASE/api/validate_key" -H "Content-Type: application/json" \
  -d '{"key":"NOWORNEVER","device_id":"test-dev-001"}' | python3 -m json.tool

echo ""
echo "== POST /api/activate (HMAC) =="
RID="test-$(date +%s)"
curl -s -X POST "$BASE/api/activate" -H "Content-Type: application/json" \
  -d "{\"key\":\"NOWORNEVER\",\"device_id\":\"test-dev-002\",\"android_id\":\"android-123\",\"wifi_bssid\":\"aa:bb:cc:dd:ee:ff\",\"wifi_ip\":\"192.168.1.10\",\"build_fp\":\"sdk_gphone\",\"rid\":\"$RID\"}" | python3 -m json.tool

echo ""
echo "== GET /api/key_status/NOWORNEVER =="
curl -s "$BASE/api/key_status/NOWORNEVER" | python3 -m json.tool

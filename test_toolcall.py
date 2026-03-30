import sys
import urllib.request
import json
import time

token = sys.argv[1] if len(sys.argv) > 1 else 'YOUR_TOKEN'

prompt = sys.argv[2] if len(sys.argv) > 2 else 'Who won the IPL 2025? Please perform a web search.'

req = urllib.request.Request(
    'http://127.0.0.1:18789/v1/chat/completions',
    data=json.dumps({
        'model': 'openclaw',
        'stream': True,
        'messages': [{'role': 'user', 'content': prompt}]
    }).encode('utf-8'),
    headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
        'x-openclaw-session-key': 'test_manual_1'
    }
)

print(f"--- Sending request to OpenClaw with session: test_manual_1 ---")
try:
    with urllib.request.urlopen(req) as res:
        for line in res:
            # Print EXACT output received, with timestamp
            print(f"[{time.strftime('%H:%M:%S')}] {line.decode('utf-8')}", end="")
            
except urllib.error.HTTPError as e:
    print(f"HTTP Error {e.code}: {e.reason}")
    print(e.read().decode('utf-8'))

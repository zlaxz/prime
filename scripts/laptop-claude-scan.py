#!/usr/bin/env python3
"""
Laptop-side Claude.ai conversation scanner.
Fetches from Claude.ai API (which Cloudflare blocks from Mac Mini)
and pushes results to Mac Mini via SSH.

Run via cron on laptop: 0 */4 * * * python3 ~/GitHub/prime/scripts/laptop-claude-scan.py

The Mac Mini then imports the JSONL file on its next sync cycle.
"""

import urllib.request, json, os, subprocess, sys, time, sqlite3, shutil, tempfile
from pathlib import Path

MAC_MINI = "macmini"
REMOTE_IMPORT_DIR = "laptop-sources/claude-api"
OUTPUT_DIR = Path("/tmp/prime-claude-scan")
OUTPUT_DIR.mkdir(exist_ok=True)

def get_session_key():
    """Extract sessionKey from Claude Desktop's encrypted cookie store."""
    import hashlib, base64

    cookie_db = Path.home() / "Library/Application Support/Claude/cookies"
    if not cookie_db.exists():
        print("No Claude Desktop cookie DB found")
        return None

    tmp = tempfile.mktemp(suffix='.db')
    shutil.copy2(cookie_db, tmp)

    conn = sqlite3.connect(tmp)
    rows = conn.execute(
        "SELECT encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%' AND name = 'sessionKey'"
    ).fetchall()
    conn.close()
    os.unlink(tmp)

    if not rows:
        return None

    # Get Keychain key
    for svc in ['Claude Safe Storage', 'Claude Desktop Safe Storage']:
        result = subprocess.run(
            ['security', 'find-generic-password', '-s', svc, '-w'],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            break
    else:
        print("Keychain access failed")
        return None

    password = result.stdout.strip()
    key = hashlib.pbkdf2_hmac('sha1', password.encode('utf-8'), b'saltysalt', 1003, dklen=16)

    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    enc_val = rows[0][0]
    if enc_val[:3] == b'v10':
        iv = b' ' * 16
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        dec = cipher.decryptor()
        decrypted = dec.update(enc_val[3:]) + dec.finalize()
        pad_len = decrypted[-1]
        raw = decrypted[:-pad_len] if pad_len <= 16 else decrypted
        decoded = raw.decode('latin-1')
        idx = decoded.find('sk-ant-')
        if idx >= 0:
            return decoded[idx:]

    return None


def claude_api_get(path, session_key, timeout=15):
    """GET from Claude.ai API."""
    req = urllib.request.Request(
        f"https://claude.ai/api{path}",
        headers={
            'Cookie': f'sessionKey={session_key}',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json',
        }
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def get_indexed_uuids():
    """Get set of conversation UUIDs already indexed on Mac Mini."""
    result = subprocess.run(
        ['ssh', MAC_MINI,
         "sqlite3 ~/.prime/prime.db \"SELECT REPLACE(source_ref, 'claude:', '') FROM knowledge WHERE source_ref LIKE 'claude:%' AND source_ref NOT LIKE 'claude-artifact:%'\""],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return set()
    return set(result.stdout.strip().split('\n'))


def main():
    # Get session key
    session_key = get_session_key()
    if not session_key:
        # Fallback: get from Mac Mini config
        result = subprocess.run(
            ['ssh', MAC_MINI,
             "cd ~/GitHub/prime && node -e \"const{getDb,getConfig}=require('./dist/db.js');console.log(getConfig(getDb(),'claude_session_key'))\""],
            capture_output=True, text=True
        )
        session_key = result.stdout.strip()

    if not session_key or not session_key.startswith('sk-ant-'):
        print("ERROR: No valid session key")
        sys.exit(1)

    # Get orgs
    result = subprocess.run(
        ['ssh', MAC_MINI,
         "cd ~/GitHub/prime && node -e \"const{getDb,getConfig}=require('./dist/db.js');const o=getConfig(getDb(),'claude_organizations')||[];console.log(JSON.stringify(o.filter(x=>x.capabilities?.includes('chat')).map(x=>({id:x.uuid,name:x.name}))))\""],
        capture_output=True, text=True
    )
    orgs = json.loads(result.stdout.strip())

    # Get already-indexed UUIDs
    indexed = get_indexed_uuids()
    print(f"Already indexed: {len(indexed)} conversations")

    # Fetch conversation lists from all orgs
    all_convos = []
    for org in orgs:
        try:
            convos = claude_api_get(f"/organizations/{org['id']}/chat_conversations", session_key)
            for c in convos:
                c['_org_id'] = org['id']
            print(f"  {org['name']}: {len(convos)} conversations")
            all_convos.extend(convos)
        except Exception as e:
            print(f"  {org['name']}: FAILED - {e}")

    # Find conversations that need processing
    to_fetch = [c for c in all_convos if c['uuid'] not in indexed]
    print(f"\nNew conversations to fetch: {len(to_fetch)}")

    if not to_fetch:
        print("Nothing to do")
        return

    # Fetch details with delay to avoid Cloudflare rate limiting
    output_file = OUTPUT_DIR / "new_conversations.jsonl"
    fetched = 0

    with open(output_file, 'w') as f:
        for i, convo_meta in enumerate(to_fetch):
            try:
                detail = claude_api_get(
                    f"/organizations/{convo_meta['_org_id']}/chat_conversations/{convo_meta['uuid']}",
                    session_key, timeout=30
                )
                detail['_org_id'] = convo_meta['_org_id']
                detail['updated_at'] = convo_meta.get('updated_at', convo_meta.get('created_at'))

                msgs = len(detail.get('chat_messages', []))
                if msgs < 2:
                    print(f"  [{i+1}/{len(to_fetch)}] Skip: {convo_meta.get('name', 'Untitled')[:40]} ({msgs} msgs)")
                    continue

                f.write(json.dumps(detail) + '\n')
                fetched += 1
                print(f"  [{i+1}/{len(to_fetch)}] OK: {convo_meta.get('name', 'Untitled')[:40]} ({msgs} msgs)")

                # Delay between fetches to avoid Cloudflare
                time.sleep(2)

            except urllib.error.HTTPError as e:
                if e.code == 403:
                    print(f"  [{i+1}/{len(to_fetch)}] Cloudflare blocked, waiting 30s...")
                    time.sleep(30)
                    # Retry once
                    try:
                        detail = claude_api_get(
                            f"/organizations/{convo_meta['_org_id']}/chat_conversations/{convo_meta['uuid']}",
                            session_key, timeout=30
                        )
                        detail['_org_id'] = convo_meta['_org_id']
                        detail['updated_at'] = convo_meta.get('updated_at', convo_meta.get('created_at'))
                        msgs = len(detail.get('chat_messages', []))
                        if msgs >= 2:
                            f.write(json.dumps(detail) + '\n')
                            fetched += 1
                            print(f"  [{i+1}/{len(to_fetch)}] Retry OK: {convo_meta.get('name', 'Untitled')[:40]}")
                    except:
                        print(f"  [{i+1}/{len(to_fetch)}] Retry FAILED")
                else:
                    print(f"  [{i+1}/{len(to_fetch)}] HTTP {e.code}")
            except Exception as e:
                print(f"  [{i+1}/{len(to_fetch)}] Error: {e}")

    print(f"\nFetched {fetched} conversations → {output_file}")

    if fetched > 0:
        # Push to Mac Mini
        subprocess.run(['ssh', MAC_MINI, f'mkdir -p ~/{REMOTE_IMPORT_DIR}'])
        subprocess.run(['scp', str(output_file), f'{MAC_MINI}:~/{REMOTE_IMPORT_DIR}/new_conversations.jsonl'])
        print(f"Pushed to Mac Mini at ~/{REMOTE_IMPORT_DIR}/")
        print("Run import on Mac Mini to ingest these conversations")


if __name__ == '__main__':
    main()

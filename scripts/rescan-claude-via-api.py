#!/usr/bin/env python3
"""
Claude conversation extraction via DeepSeek swarm.
Writes results to Mac Mini via REST API (not direct DB).

Runs entirely on LAPTOP:
- Reads session key from laptop's DB
- Fetches conversations from Claude.ai API
- Extracts via DeepSeek Reasoner swarm
- Writes to Mac Mini via POST /api/remember (safe, no DB corruption)

Usage: python3 scripts/rescan-claude-via-api.py [--dry-run] [--limit N]
"""

import asyncio
import json
import os
import sys
import time
import sqlite3
import urllib.request
import urllib.error

sys.path.insert(0, os.path.expanduser('~/.claude/scripts'))
from swarm_executor import Swarm

# Config
LOCAL_DB = os.path.expanduser('~/.prime/prime.db')
MAC_MINI_API = 'http://Zachs-Mac-mini.local:3210'

EXTRACTION_PROMPT = """Extract a SEARCH-OPTIMIZED summary from this Claude conversation.
The summary is an INDEX CARD — it must contain every keyword someone would use to find this content.

Rules:
1. Include EVERY specific noun: person names, company names, product names, project names
2. Include EVERY number: "78 agencies", "$800 budget", "15,000 facilities", "72-hour quotes"
3. Include EVERY deliverable: "contact list", "email template", "marketing plan", "budget spreadsheet"
4. Include EVERY concept: "Dale Dupree", "Selling From The Heart", "pattern interrupt", "crumpled letter"
5. Include EVERY decision: "decided to pause", "chose approach B", "rejected equity structure"
6. The summary should be 200-500 words — comprehensive, not compressed
7. Start with a one-line title that captures the main topic

Return JSON:
{
  "title": "Clear descriptive title (max 80 chars)",
  "summary": "200-500 word search-optimized summary with all key terms",
  "contacts": ["Full Name of each person mentioned"],
  "organizations": ["Company/org names"],
  "tags": ["every", "relevant", "keyword"],
  "project": "Project name if identifiable, or null",
  "importance": "low|normal|high|critical"
}

CONVERSATION:
"""


def claude_api_get(path, session_key):
    url = f'https://claude.ai/api{path}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
        'Cookie': f'sessionKey={session_key}',
        'Accept': 'application/json',
    })
    try:
        return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except Exception as e:
        print(f'  API error: {e}')
        return None


def mac_mini_post(path, data):
    """Post to Mac Mini API — the SAFE way to write data."""
    url = f'{MAC_MINI_API}{path}'
    payload = json.dumps(data).encode()
    req = urllib.request.Request(url, data=payload, headers={
        'Content-Type': 'application/json',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        return json.loads(resp.read())
    except Exception as e:
        return {'error': str(e)}


def mac_mini_get(path):
    url = f'{MAC_MINI_API}{path}'
    try:
        return json.loads(urllib.request.urlopen(url, timeout=10).read())
    except:
        return None


async def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()

    # Get session key from LOCAL DB
    db = sqlite3.connect(LOCAL_DB)
    row = db.execute("SELECT value FROM config WHERE key='claude_session_key'").fetchone()
    session_key = json.loads(row[0]) if row else None
    org_row = db.execute("SELECT value FROM config WHERE key='claude_organizations'").fetchone()
    orgs = json.loads(org_row[0]) if org_row else []
    db.close()

    if not session_key:
        print('ERROR: No session key in local DB')
        return

    # Phase 1: List all conversations
    print('Phase 1: Listing all conversations...')
    all_convos = []
    for org in orgs:
        if 'chat' not in (org.get('capabilities') or []):
            continue
        convos = claude_api_get(f'/organizations/{org["uuid"]}/chat_conversations', session_key)
        if convos:
            for c in convos:
                c['_org_id'] = org['uuid']
                c['_org_name'] = org['name']
            all_convos.extend(convos)
            print(f'  {org["name"]}: {len(convos)}')

    print(f'  Total: {len(all_convos)}')

    # Check what Mac Mini already has
    status = mac_mini_get('/api/status')
    print(f'  Mac Mini has: {status.get("total_items", "?")} items')

    # Search Mac Mini for existing claude items
    existing_search = mac_mini_post('/api/search', {'query': 'claude-conversation', 'limit': 1000})
    existing_refs = set()
    for r in (existing_search or {}).get('results', []):
        if r.get('source_ref', '').startswith('claude:'):
            existing_refs.add(r['source_ref'])
    print(f'  Already indexed: {len(existing_refs)}')

    to_process = [c for c in all_convos if f'claude:{c["uuid"]}' not in existing_refs]
    print(f'  New: {len(to_process)}')

    if args.limit:
        to_process = to_process[:args.limit]

    if args.dry_run:
        print(f'\n[DRY RUN] Would process {len(to_process)} conversations')
        for c in to_process[:10]:
            print(f'  {c.get("name", "untitled")} ({c["uuid"][:8]})')
        return

    if not to_process:
        print('Nothing to process.')
        return

    # Phase 2: Fetch full content
    print(f'\nPhase 2: Fetching {len(to_process)} conversations...')
    fetched = []
    for i, c in enumerate(to_process):
        full = claude_api_get(f'/organizations/{c["_org_id"]}/chat_conversations/{c["uuid"]}', session_key)
        if full:
            messages = full.get('chat_messages', [])
            text = '\n\n'.join(f'[{m.get("sender","?")}]: {m.get("text","")}' for m in messages if m.get('text'))
            if len(text) > 100:
                fetched.append({
                    'uuid': c['uuid'],
                    'name': c.get('name') or full.get('name', 'Untitled'),
                    'created_at': c.get('created_at', ''),
                    'updated_at': c.get('updated_at', ''),
                    'org_name': c['_org_name'],
                    'text': text[:20000],
                    'full_length': len(text),
                    'message_count': len(messages),
                })
        if (i + 1) % 10 == 0:
            print(f'  Fetched: {i + 1}/{len(to_process)} ({len(fetched)} with content)')
            await asyncio.sleep(1)

    print(f'  {len(fetched)} with content')

    # Phase 3: DeepSeek extraction
    print(f'\nPhase 3: DeepSeek Reasoner extraction...')
    start = time.time()
    tasks = [{'prompt': EXTRACTION_PROMPT + f['text'], 'id': f['uuid']} for f in fetched]

    extractions = {}
    for batch_start in range(0, len(tasks), 100):
        batch = tasks[batch_start:batch_start + 100]
        print(f'  Batch: {batch_start + 1}-{min(batch_start + len(batch), len(tasks))} of {len(tasks)}')
        result = await Swarm.run(batch, model='deepseek-reasoner', max_tokens=2000, temperature=0.1)
        for r in result.results:
            if r.success:
                try:
                    out = r.output.strip()
                    if out.startswith('```'): out = out.split('\n', 1)[1].rsplit('```', 1)[0].strip()
                    extractions[r.task_id] = json.loads(out)
                except:
                    extractions[r.task_id] = {'title': 'Claude conversation', 'summary': r.output[:500], 'contacts': [], 'tags': [], 'project': None, 'importance': 'normal'}
        print(f'    {result.successful}/{result.total_tasks} ok, {result.total_tokens} tokens')

    print(f'  Done: {len(extractions)} in {time.time()-start:.0f}s')

    # Phase 4: Write to Mac Mini via API
    print(f'\nPhase 4: Writing to Mac Mini via API...')
    written = 0
    failed = 0
    for f in fetched:
        ext = extractions.get(f['uuid'])
        if not ext:
            continue

        # Use /api/remember which handles extraction + embedding on the server
        # But we already extracted — so use /api/ingest with pre-extracted data
        result = mac_mini_post('/api/ingest', {
            'items': [{
                'title': ext.get('title', f['name'])[:200],
                'summary': ext.get('summary', '')[:5000],
                'source': 'claude',
                'source_ref': f'claude:{f["uuid"]}',
                'source_date': f['updated_at'] or f['created_at'],
                'contacts': ext.get('contacts', []),
                'organizations': ext.get('organizations', []),
                'tags': ext.get('tags', []) + ['claude-conversation'],
                'project': ext.get('project'),
                'importance': ext.get('importance', 'normal'),
                'metadata': {
                    'conversation_uuid': f['uuid'],
                    'message_count': f['message_count'],
                    'full_length': f['full_length'],
                    'org_name': f['org_name'],
                    'conversation_text': f['text'][:50000],
                },
            }]
        })

        if result and not result.get('error'):
            written += 1
        else:
            failed += 1
            if failed <= 3:
                print(f'    Failed: {f["name"][:50]} — {result}')

        if (written + failed) % 50 == 0:
            print(f'  Progress: {written} written, {failed} failed of {len(fetched)}')

    print(f'\n  DONE: {written} written, {failed} failed')
    print(f'  Total time: {time.time()-start:.0f}s')


if __name__ == '__main__':
    asyncio.run(main())

#!/usr/bin/env python3
"""
Full Claude.ai conversation re-extraction via DeepSeek Reasoner swarm.

Pulls ALL conversations from ALL orgs, fetches full content,
extracts with search-optimized summaries via 100-agent parallel swarm,
generates embeddings, stores in Prime's SQLite DB.

Usage: python3 scripts/rescan-claude-swarm.py [--dry-run] [--limit N]
"""

import asyncio
import json
import os
import sys
import time
import sqlite3
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# Add swarm executor
sys.path.insert(0, os.path.expanduser('~/.claude/scripts'))
from swarm_executor import Swarm

# ── Config ──
DB_PATH = os.path.expanduser('~/.prime/prime.db')
EXTRACT_CONCURRENCY = 100  # DeepSeek swarm batch size
OPENAI_BATCH_SIZE = 100

# ── Extraction prompt — designed for SEARCHABILITY ──
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
  "summary": "200-500 word search-optimized summary with all key terms, names, numbers, decisions, deliverables",
  "contacts": ["Full Name of each person mentioned"],
  "organizations": ["Company/org names"],
  "decisions": ["Key decisions made"],
  "commitments": ["Promises or action items"],
  "tags": ["every", "relevant", "keyword", "for", "search"],
  "project": "Project name if identifiable, or null",
  "importance": "low|normal|high|critical",
  "key_artifacts": ["List any documents, lists, templates, or deliverables created in this conversation"]
}

CONVERSATION:
"""


def get_db():
    return sqlite3.connect(DB_PATH)


def get_config(db, key):
    row = db.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    if not row: return None
    try: return json.loads(row[0])
    except: return row[0]


def claude_api_get(path, session_key):
    """Fetch from Claude.ai API"""
    url = f'https://claude.ai/api{path}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
        'Cookie': f'sessionKey={session_key}',
        'Accept': 'application/json',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f'  API error {e.code} for {path}')
        return None


async def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()

    db = get_db()
    session_key = get_config(db, 'claude_session_key')
    openai_key = get_config(db, 'openai_api_key')
    orgs = get_config(db, 'claude_organizations') or []

    if not session_key:
        print('ERROR: No Claude session key. Run: recall connect claude')
        return

    # ── Phase 1: List ALL conversations from ALL orgs ──
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
            print(f'  {org["name"]}: {len(convos)} conversations')

    print(f'  Total: {len(all_convos)} conversations')

    # Check what's already indexed
    existing_refs = set()
    for row in db.execute("SELECT source_ref FROM knowledge WHERE source = 'claude'").fetchall():
        existing_refs.add(row[0])

    to_process = []
    for c in all_convos:
        ref = f'claude:{c["uuid"]}'
        if ref not in existing_refs:
            to_process.append(c)

    print(f'  Already indexed: {len(existing_refs)}')
    print(f'  New to process: {len(to_process)}')

    if args.limit:
        to_process = to_process[:args.limit]
        print(f'  Limited to: {len(to_process)}')

    if args.dry_run:
        print('\n[DRY RUN] Would process:')
        for c in to_process[:10]:
            print(f'  {c.get("name", "untitled")} ({c["uuid"][:8]})')
        if len(to_process) > 10:
            print(f'  ... and {len(to_process) - 10} more')
        return

    if not to_process:
        print('Nothing new to process.')
        return

    # ── Phase 2: Fetch full content ──
    print(f'\nPhase 2: Fetching {len(to_process)} conversations...')
    fetched = []
    for i, c in enumerate(to_process):
        full = claude_api_get(
            f'/organizations/{c["_org_id"]}/chat_conversations/{c["uuid"]}',
            session_key
        )
        if full:
            messages = full.get('chat_messages', [])
            text = '\n\n'.join(
                f'[{m.get("sender", "?")}]: {m.get("text", "")}'
                for m in messages
                if m.get('text')
            )
            if len(text) > 100:  # Skip empty/trivial conversations
                fetched.append({
                    'uuid': c['uuid'],
                    'name': c.get('name') or full.get('name', 'Untitled'),
                    'created_at': c.get('created_at', ''),
                    'updated_at': c.get('updated_at', ''),
                    'project_uuid': c.get('project_uuid'),
                    'org_name': c['_org_name'],
                    'text': text[:20000],  # Cap at 20K for extraction
                    'full_length': len(text),
                    'message_count': len(messages),
                    'is_starred': c.get('is_starred', False),
                    'model': c.get('model'),
                })

        if (i + 1) % 10 == 0 or i + 1 == len(to_process):
            print(f'  Fetched: {i + 1}/{len(to_process)} ({len(fetched)} with content)')

        # Rate limit: 10 per second
        if (i + 1) % 10 == 0:
            await asyncio.sleep(1)

    print(f'  {len(fetched)} conversations with content')

    # ── Phase 3: DeepSeek Reasoner swarm extraction ──
    print(f'\nPhase 3: Extracting with DeepSeek Reasoner swarm...')
    start = time.time()

    tasks = []
    for f in fetched:
        tasks.append({
            'prompt': EXTRACTION_PROMPT + f['text'],
            'id': f['uuid'],
        })

    # Run in batches of 100
    all_extractions = {}
    for batch_start in range(0, len(tasks), EXTRACT_CONCURRENCY):
        batch = tasks[batch_start:batch_start + EXTRACT_CONCURRENCY]
        print(f'  Swarm batch: {batch_start + 1}-{min(batch_start + len(batch), len(tasks))} of {len(tasks)}')

        result = await Swarm.run(batch, model='deepseek-reasoner', max_tokens=2000, temperature=0.1)

        for r in result.results:
            if r.success:
                try:
                    # Try to parse JSON from the output
                    output = r.output.strip()
                    if output.startswith('```'):
                        output = output.split('\n', 1)[1].rsplit('```', 1)[0].strip()
                    extracted = json.loads(output)
                    all_extractions[r.task_id] = extracted
                except:
                    # Fallback: use raw output as summary
                    all_extractions[r.task_id] = {
                        'title': 'Claude conversation',
                        'summary': r.output[:500],
                        'contacts': [], 'organizations': [], 'decisions': [],
                        'commitments': [], 'tags': [], 'project': None,
                        'importance': 'normal', 'key_artifacts': [],
                    }

        print(f'    {result.successful}/{result.total_tasks} succeeded, {result.total_tokens} tokens')

    elapsed = time.time() - start
    print(f'  Extraction complete: {len(all_extractions)} in {elapsed:.0f}s')

    # ── Phase 4: Generate embeddings ──
    print(f'\nPhase 4: Generating embeddings...')
    import openai
    client = openai.OpenAI(api_key=openai_key)

    embedding_texts = []
    embedding_uuids = []
    for f in fetched:
        ext = all_extractions.get(f['uuid'], {})
        text = f"{ext.get('title', f['name'])}\n{ext.get('summary', '')}"
        embedding_texts.append(text[:8000])
        embedding_uuids.append(f['uuid'])

    embeddings = {}
    for i in range(0, len(embedding_texts), OPENAI_BATCH_SIZE):
        batch = embedding_texts[i:i + OPENAI_BATCH_SIZE]
        resp = client.embeddings.create(model='text-embedding-3-small', input=batch)
        for j, emb in enumerate(resp.data):
            embeddings[embedding_uuids[i + j]] = emb.embedding
        print(f'  Embeddings: {min(i + OPENAI_BATCH_SIZE, len(embedding_texts))}/{len(embedding_texts)}')

    # ── Phase 5: Store in database ──
    print(f'\nPhase 5: Storing {len(fetched)} items...')
    import uuid as uuid_mod
    import struct

    stored = 0
    for f in fetched:
        ext = all_extractions.get(f['uuid'], {})
        emb = embeddings.get(f['uuid'])

        if not ext or not emb:
            continue

        emb_blob = struct.pack(f'{len(emb)}f', *emb)

        db.execute("""
            INSERT OR REPLACE INTO knowledge
            (id, title, summary, source, source_ref, source_date,
             contacts, organizations, decisions, commitments, action_items,
             tags, project, importance, embedding, metadata,
             created_at, updated_at)
            VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        """, (
            str(uuid_mod.uuid4()),
            ext.get('title', f['name'])[:200],
            ext.get('summary', '')[:5000],
            f'claude:{f["uuid"]}',
            f['updated_at'] or f['created_at'],
            json.dumps(ext.get('contacts', [])),
            json.dumps(ext.get('organizations', [])),
            json.dumps(ext.get('decisions', [])),
            json.dumps(ext.get('commitments', [])),
            json.dumps([]),  # action_items
            json.dumps(ext.get('tags', []) + ['claude-conversation']),
            ext.get('project'),
            ext.get('importance', 'normal'),
            emb_blob,
            json.dumps({
                'conversation_uuid': f['uuid'],
                'message_count': f['message_count'],
                'full_length': f['full_length'],
                'org_name': f['org_name'],
                'model': f['model'],
                'is_starred': f['is_starred'],
                'key_artifacts': ext.get('key_artifacts', []),
                'conversation_text': f['text'][:50000],  # Store full text for retrieval
            }),
        ))
        stored += 1

    db.commit()
    db.close()

    print(f'\n  DONE: {stored} conversations stored')
    print(f'  Total time: {time.time() - start:.0f}s')
    print(f'  DeepSeek cost: ~${len(fetched) * 0.004:.2f}')


if __name__ == '__main__':
    asyncio.run(main())

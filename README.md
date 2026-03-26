<p align="center">
  <h1 align="center">Prime Recall</h1>
  <p align="center"><strong>The AI that already knows your business.</strong></p>
  <p align="center">
    Connect your email and Claude conversations. In 60 seconds,<br/>
    Prime Recall knows every relationship, every commitment, every dropped ball.<br/>
    Then it never lets you forget again.
  </p>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#intelligence-commands"><strong>Intelligence</strong></a> ·
  <a href="#claude-desktop-integration"><strong>Claude Desktop</strong></a> ·
  <a href="#api--mcp"><strong>API & MCP</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/local--first-✓-green" alt="Local First" />
  <img src="https://img.shields.io/badge/privacy--first-✓-green" alt="Privacy First" />
</p>

---

## The Problem

Your knowledge is scattered across Gmail, Google Calendar, Claude conversations, meeting notes, and your head. AI tools start every session knowing nothing about you. You repeat yourself. Things fall through cracks. People wait for replies you forgot about.

Worse: your Claude conversations are trapped in project silos. The pricing analysis you did last week? Invisible to the conversation you're having about a partnership today.

**Prime Recall unifies everything into one searchable knowledge base that any AI can query.**

## The Magic Moment

```
$ recall connect claude

  Extracting session key from Claude Desktop...
  ✓ Session key extracted from Claude Desktop
  ✓ Connected to Claude.ai
  Organizations:
    Personal (active)
    Acme Corp

  Scanning your Claude conversations...

  Found 781 total, 70 in last 90 days
  Phase 1: Fetching conversation details...
  Phase 2: AI extraction on 70 conversations...
  Phase 3: Generating embeddings...
  Phase 4: Saving to knowledge base...

  ✓ 70 conversations → 70 knowledge items (12 artifacts)
  ✓ Every project, every org, all searchable together

  Try: recall search "who should I follow up with"
  Try: recall alerts
  Try: recall open "pricing strategy"
```

Every Claude conversation across every project and every org — unified. The silos are broken.

## Quick Start

```bash
# Install
npm install -g prime-recall

# Initialize (one API key for embeddings — ~$0.02 per 1M tokens)
recall init

# Connect your data sources
recall connect gmail           # OAuth flow — 60 seconds
recall connect claude          # Auto-extracts from Claude Desktop
recall connect calendar        # Google Calendar events

# Set up Claude Desktop integration (one command)
recall setup desktop           # Configures MCP + permissions + system prompt

# Restart Claude Desktop — done. It now knows your entire business.
```

## What It Does

Prime Recall is an **index**, not a copy of your data.

```
YOUR DATA (stays where it lives)          PRIME RECALL (lightweight index)
├── Gmail threads                          ├── AI-extracted summaries
├── Google Calendar events                 ├── Contacts & organizations
├── Claude.ai conversations (ALL orgs)  →  ├── Decisions & commitments
├── Otter.ai meeting transcripts           ├── Semantic vector search
├── Local files & documents                ├── Relationship health graph
└── Manual captures                        └── Pointers back to originals
```

Every piece of content is analyzed by AI to extract: **contacts, organizations, decisions, commitments, action items, importance, and project associations.** Then embedded as a vector for semantic search.

The Claude.ai connector pulls conversations from **all projects and all organizations** — breaking the silo problem that makes Claude's project feature frustrating.

## Intelligence Commands

These are the features that make Prime Recall more than a search engine.

| Command | What It Does |
|---------|-------------|
| `recall alerts` | What needs attention NOW — dropped balls, overdue commitments, cold relationships |
| `recall briefing` | Morning intelligence brief — priorities, schedule, commitments, relationship health |
| `recall prep "Sarah Chen"` | Intelligence dossier — every interaction, commitment, decision about a person or topic |
| `recall deal "Project Alpha"` | Deal intelligence — timeline, people, decisions, status, risks, next steps |
| `recall catchup` | What happened while you were away — narrative summary across all sources |
| `recall relationships` | Contact health dashboard — who's active, warm, cooling, cold, dormant |
| `recall commitments` | Outstanding promises tracker — overdue, due soon, active, fulfilled, dropped |
| `recall open "query"` | Search and open the source conversation in your browser |

### Example: `recall alerts`

```
⚠️  12 ALERTS

  🔴 [CRITICAL] Sarah Chen waiting on your reply
     "Partnership Proposal Follow-up" — 23 days with no response
     📁 Acme Partnership

  🟠 [HIGH] Overdue: Send updated proposal to Mike
     Due 2025-03-22 (4d ago) — Project Alpha

  🟡 Due TOMORROW: Certification deck review with team
     Due 2025-03-27 — Project Alpha

  🔵 David Park going cold
     Last interaction 28d ago (15 total mentions)
```

### Example: `recall prep "Sarah Chen"`

Generates a full intelligence dossier: every email, every Claude conversation, every meeting, every commitment, every decision — across all sources. Chronological history, current status, recommended talking points.

## Claude Desktop Integration

One command sets up everything:

```bash
recall setup desktop
```

This:
1. Configures the MCP server in `claude_desktop_config.json`
2. Auto-approves all Prime Recall tools (no permission prompts)
3. Updates your claude.ai conversation preferences to make Claude search Prime Recall by default

After restarting Claude Desktop, **every conversation** has access to your entire business knowledge base. Claude will proactively search Prime Recall before answering questions about your business.

### 14 MCP Tools

| Tool | When Claude Uses It |
|------|-------------------|
| `prime_search` | Any question about your business, contacts, or projects |
| `prime_ask` | Deep questions requiring AI reasoning over your knowledge |
| `prime_alerts` | "What needs attention?", "Any urgent items?" |
| `prime_prep` | "Brief me on Sarah", "Prep me for my meeting" |
| `prime_deal` | "Status of Project Alpha?", "Where are we with Acme?" |
| `prime_briefing` | "Morning briefing", "What's my day look like?" |
| `prime_catchup` | "Catch me up", "What did I miss?" |
| `prime_relationships` | "Who should I follow up with?" |
| `prime_remember` | Saves new knowledge from the conversation |
| `prime_get_contacts` | Contact list with mention frequency |
| `prime_get_commitments` | Outstanding commitments with state tracking |
| `prime_get_projects` | Projects detected across all sources |
| `prime_get_connections` | Knowledge graph for a person or topic |
| `prime_status` | Knowledge base statistics |

### Chrome Extension as Universal Connector

The Claude Chrome extension (paired to Desktop) can save any web page to Prime Recall. On Otter.ai viewing a transcript? LinkedIn viewing a prospect? Any web tool? Tell Claude "save this to Prime Recall" and it calls `prime_remember` with the page content. Zero code, infinite sources.

## All Commands

| Command | What It Does |
|---------|-------------|
| `recall init` | Set up Prime Recall with your API key |
| `recall connect gmail` | Connect Gmail — OAuth + 90-day scan |
| `recall connect calendar` | Connect Google Calendar — OAuth + event indexing |
| `recall connect claude` | Connect Claude.ai — auto sessionKey + conversation scan |
| `recall setup desktop` | One-command Claude Desktop configuration |
| `recall search <query>` | Semantic search across all sources |
| `recall ask <question>` | AI answer grounded in YOUR data with cited sources |
| `recall remember <text>` | Quick capture — decisions, commitments, facts |
| `recall alerts` | Dropped balls, overdue commitments, cold relationships |
| `recall briefing` | Morning intelligence briefing |
| `recall prep <query>` | Intelligence dossier on a person/topic/meeting |
| `recall deal <project>` | Deal/project intelligence brief |
| `recall catchup` | What happened while you were away |
| `recall relationships` | Contact health dashboard |
| `recall commitments` | Outstanding promises tracker |
| `recall open <query>` | Open source conversation in browser |
| `recall ingest <file>` | Index a file |
| `recall index <directory>` | Index a directory |
| `recall sync` | Refresh all connected sources |
| `recall serve` | Start API + MCP server with background sync |
| `recall status` | Show what Prime Recall knows |
| `recall refine` | Re-process with business context, build connections |

## Data Sources

| Source | Status | How It Works |
|--------|--------|-------------|
| **Claude.ai** | Working | Live API — pulls from ALL projects and orgs, extracts artifacts |
| **Gmail** | Working | OAuth — thread scanning, dropped ball detection |
| **Google Calendar** | Working | OAuth — event indexing with attendee context |
| **Otter.ai** | Working | Webhook receiver + file import |
| **Local files** | Working | Directory indexing (md, txt, json, pdf, code) |
| **Chrome extension** | Working | Save any web page via Claude Desktop |
| Slack | Planned | |
| Notion | Planned | |

### Claude.ai Connector — The Breakthrough

The hardest data source to crack. Claude.ai has no public API for conversation history. Prime Recall:

1. Auto-extracts the session key from Claude Desktop's encrypted cookie store (macOS Keychain decryption)
2. Uses the internal REST API with a spoofed browser User-Agent (bypasses Cloudflare)
3. Pulls conversations in parallel (10 concurrent fetches, 5 concurrent AI extractions, batched embeddings)
4. Extracts artifacts from `<antArtifact>` XML tags
5. Indexes across ALL organizations and ALL projects — breaking the silo problem

Supports `CLAUDE_SESSION_KEY` env var and `--session-key` flag for environments without Keychain access.

## REST API

`recall serve` starts a local API server on port 3210:

```
POST /api/search     — Semantic search
POST /api/ask        — AI Q&A grounded in knowledge base
POST /api/ingest     — Add knowledge from any source
POST /api/remember   — Quick capture
GET  /api/status     — Knowledge base stats
GET  /api/query/contacts      — All known contacts
GET  /api/query/commitments   — Outstanding commitments
GET  /api/query/projects      — Detected projects
POST /api/webhooks/otter      — Otter.ai webhook receiver
```

## Architecture

```
~/.prime/
├── prime.db           — SQLite + vector search (local, portable)
├── artifacts/         — Saved documents
├── conversations/     — Exported conversations
├── cache/             — Embedding cache
└── logs/              — Sync logs
```

- **Database:** SQLite via sql.js with brute-force cosine similarity (fast to ~10K items)
- **Embeddings:** OpenAI text-embedding-3-small (1536 dimensions)
- **AI Extraction:** Configurable — OpenAI, Claude, DeepSeek, OpenRouter
- **Zero infrastructure:** No Docker, no Postgres, no cloud required
- **Single file database:** Copy `prime.db` to move your entire knowledge base

## Privacy

- **Local-first:** All data stored in `~/.prime/` on your machine
- **No telemetry:** Zero tracking, zero analytics
- **No accounts:** No sign-up, no cloud dependency
- **Minimal API calls:** Only OpenAI for embeddings (~$0.02/1M tokens)
- **Open source:** MIT license — inspect every line

Your data never leaves your machine except for embedding generation.

## Roadmap

- [ ] Background sync daemon (Mac Mini / VPS)
- [ ] Supabase cloud option (multi-device, mobile access)
- [ ] Local embeddings via Ollama (zero API cost)
- [ ] Web dashboard UI
- [ ] Slack, Notion, HubSpot connectors
- [ ] Knowledge graph visualization
- [ ] Competitive intelligence monitoring (web search on schedule)
- [ ] Voice capture ("Hey Prime, I just talked to Sarah...")
- [ ] Multi-user / team knowledge sharing

## Contributing

PRs welcome. The easiest way to contribute is building a new connector:

```bash
git clone https://github.com/zlaxz/prime-recall
cd prime-recall
npm install
npm run dev -- status
```

## License

MIT — do whatever you want with it.

---

<p align="center">
  <strong>Built for business operators who need AI that actually knows their world.</strong><br/>
  <em>Connect your sources. Ask anything. Never forget again.</em>
</p>

import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

// ============================================================
// Noise Filter
//
// Three-layer defense against data pollution:
// 1. Domain blocking — known noise domains never enter the system
// 2. Content classification — cold emails, newsletters, automated reports tagged as noise
// 3. Entity quarantine — entities only appearing in noise items are auto-dismissed
//
// Runs BEFORE extraction to prevent garbage from entering the knowledge graph.
// ============================================================

// Known noise domains — marketing, newsletters, automated reports
const DEFAULT_BLOCKED_DOMAINS = [
  'mailsuite.com', 'mailchimp.com', 'constantcontact.com', 'hubspot.com',
  'sendinblue.com', 'mailgun.com', 'sendgrid.com', 'campaign-archive.com',
  'gogridhub.com', // GridProtect spam
  'linkedin.com', // LinkedIn notifications, not real correspondence
  'noreply', 'no-reply', 'donotreply', 'notifications',
  'mailer-daemon', 'postmaster',
];

// Cold email signal words — if 3+ appear in a short email, it's likely cold outreach
const COLD_EMAIL_SIGNALS = [
  'unsubscribe', 'opt out', 'opt-out', 'click here to',
  'schedule a call', 'schedule a meeting', 'book a demo',
  'i came across', 'i noticed', 'i wanted to reach out',
  'would love to connect', 'quick question for you',
  'following up on my last', 'just checking in',
  'are you the right person', 'who handles',
  'we help companies like', 'we work with',
  'limited time', 'special offer', 'exclusive',
  'powered by', 'sent via', 'view in browser',
];

// Automated report patterns
const AUTOMATED_PATTERNS = [
  /daily report/i, /weekly report/i, /monthly report/i,
  /daily digest/i, /weekly digest/i,
  /mailsuite/i, /email tracking/i,
  /automated.*message/i, /do not reply/i,
  /this is an automated/i, /auto-generated/i,
  /newsletter/i, /newsflash/i,
  /\d+ emails? sent/i, /read rate/i, /click rate/i, /open rate/i,
];

export interface NoiseClassification {
  is_noise: boolean;
  noise_type: 'blocked_domain' | 'cold_email' | 'automated_report' | 'newsletter' | null;
  confidence: number;
  reason: string;
}

// ============================================================
// Schema
// ============================================================

export function ensureNoiseSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_domains (
      domain TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS noise_log (
      id TEXT PRIMARY KEY,
      knowledge_item_id TEXT,
      noise_type TEXT NOT NULL,
      confidence REAL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default blocked domains
  const insert = db.prepare('INSERT OR IGNORE INTO blocked_domains (domain, reason) VALUES (?, ?)');
  for (const domain of DEFAULT_BLOCKED_DOMAINS) {
    insert.run(domain, 'Default blocked domain');
  }
}

// ============================================================
// Classification (no LLM needed — pure heuristics)
// ============================================================

export function classifyNoise(
  db: Database.Database,
  content: {
    from?: string;        // sender email/name
    subject?: string;     // email subject
    body?: string;        // email body or transcript
    source?: string;      // 'gmail', 'otter', etc.
  }
): NoiseClassification {
  ensureNoiseSchema(db);

  const fromLower = (content.from || '').toLowerCase();
  const subjectLower = (content.subject || '').toLowerCase();
  const bodyLower = (content.body || '').toLowerCase();
  const allText = `${subjectLower} ${bodyLower}`;

  // Layer 1: Domain blocking
  const blockedDomains = db.prepare('SELECT domain FROM blocked_domains').all() as { domain: string }[];
  for (const { domain } of blockedDomains) {
    if (fromLower.includes(domain)) {
      return {
        is_noise: true,
        noise_type: 'blocked_domain',
        confidence: 1.0,
        reason: `Sender domain matches blocked domain: ${domain}`,
      };
    }
  }

  // Layer 2: Automated report detection
  for (const pattern of AUTOMATED_PATTERNS) {
    if (pattern.test(subjectLower) || pattern.test(bodyLower.slice(0, 500))) {
      return {
        is_noise: true,
        noise_type: 'automated_report',
        confidence: 0.9,
        reason: `Matches automated report pattern: ${pattern}`,
      };
    }
  }

  // Layer 3: Cold email detection (signal word counting)
  let coldSignals = 0;
  const matchedSignals: string[] = [];
  for (const signal of COLD_EMAIL_SIGNALS) {
    if (allText.includes(signal)) {
      coldSignals++;
      matchedSignals.push(signal);
    }
  }

  // 3+ signals in a short email = cold outreach
  const wordCount = allText.split(/\s+/).length;
  if (coldSignals >= 3 || (coldSignals >= 2 && wordCount < 200)) {
    return {
      is_noise: true,
      noise_type: 'cold_email',
      confidence: Math.min(0.6 + coldSignals * 0.1, 0.95),
      reason: `${coldSignals} cold email signals: ${matchedSignals.slice(0, 3).join(', ')}`,
    };
  }

  // Not noise
  return { is_noise: false, noise_type: null, confidence: 0, reason: '' };
}

// ============================================================
// Bulk noise scan — classify all existing items
// ============================================================

export function scanForNoise(
  db: Database.Database,
  options: { verbose?: boolean; tag?: boolean } = {}
): { scanned: number; noise_found: number; tagged: number } {
  ensureNoiseSchema(db);
  const log = options.verbose ? console.log : () => {};

  const items = db.prepare(`
    SELECT id, title, summary, source,
           json_extract(metadata, '$.subject') as subject,
           json_extract(metadata, '$.last_from') as from_addr
    FROM knowledge
    WHERE importance != 'noise'
    ORDER BY source_date DESC
  `).all() as any[];

  const stats = { scanned: 0, noise_found: 0, tagged: 0 };

  for (const item of items) {
    stats.scanned++;
    const result = classifyNoise(db, {
      from: item.from_addr || '',
      subject: item.subject || item.title || '',
      body: item.summary || '',
      source: item.source,
    });

    if (result.is_noise) {
      stats.noise_found++;
      log(`  [${result.noise_type}] ${item.title.slice(0, 60)} — ${result.reason.slice(0, 60)}`);

      // Log the detection
      db.prepare('INSERT OR IGNORE INTO noise_log (id, knowledge_item_id, noise_type, confidence, reason) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), item.id, result.noise_type, result.confidence, result.reason);

      // Tag the item as noise
      if (options.tag) {
        db.prepare("UPDATE knowledge SET importance = 'noise' WHERE id = ?").run(item.id);
        stats.tagged++;
      }
    }
  }

  return stats;
}

// ============================================================
// Entity quarantine — dismiss entities that only appear in noise
// ============================================================

export function quarantineNoiseEntities(
  db: Database.Database,
  options: { verbose?: boolean } = {}
): { quarantined: number } {
  const log = options.verbose ? console.log : () => {};
  const stats = { quarantined: 0 };

  // Find entities where ALL mentions are in noise items
  const noiseOnlyEntities = db.prepare(`
    SELECT e.id, e.canonical_name, COUNT(em.id) as total_mentions,
           SUM(CASE WHEN k.importance = 'noise' THEN 1 ELSE 0 END) as noise_mentions
    FROM entities e
    JOIN entity_mentions em ON em.entity_id = e.id
    JOIN knowledge k ON k.id = em.knowledge_item_id
    WHERE e.user_dismissed = 0
    GROUP BY e.id
    HAVING noise_mentions = total_mentions AND total_mentions > 0
  `).all() as any[];

  for (const entity of noiseOnlyEntities) {
    db.prepare('UPDATE entities SET user_dismissed = 1 WHERE id = ?').run(entity.id);
    db.prepare('INSERT OR IGNORE INTO dismissals (id, entity_id, reason) VALUES (?, ?, ?)')
      .run(uuid(), entity.id, `Auto-quarantined: all ${entity.total_mentions} mentions are in noise items`);
    stats.quarantined++;
    log(`  Quarantined: ${entity.canonical_name} (${entity.total_mentions} noise-only mentions)`);
  }

  return stats;
}

// ============================================================
// CLI: Block a domain
// ============================================================

export function blockDomain(db: Database.Database, domain: string, reason?: string) {
  ensureNoiseSchema(db);
  db.prepare('INSERT OR REPLACE INTO blocked_domains (domain, reason) VALUES (?, ?)')
    .run(domain.toLowerCase(), reason || 'User-blocked');
}

export function getBlockedDomains(db: Database.Database): { domain: string; reason: string }[] {
  ensureNoiseSchema(db);
  return db.prepare('SELECT domain, reason FROM blocked_domains ORDER BY domain').all() as any[];
}

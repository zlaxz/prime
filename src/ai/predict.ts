import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getBulkProvider } from './providers.js';
import { getConfig } from '../db.js';

// ============================================================
// Entity Prediction Engine
//
// Computes per-entity communication baselines and detects anomalies.
// Pure SQL for baselines, DeepSeek Reasoner for interpretation.
//
// Metrics tracked:
// - Response latency (how fast do they reply)
// - Engagement velocity (messages per week trend)
// - Initiative ratio (who starts conversations)
// - Recency (days since last contact)
// - Communication frequency (weekly cadence)
// ============================================================

export interface EntityPrediction {
  entity_id: string;
  entity_name: string;
  relationship_type: string | null;

  // Baselines (30-day averages)
  avg_mentions_per_week: number;
  avg_gap_days: number;           // average days between mentions
  inbound_ratio: number;          // % of mentions that are inbound (they reach out)
  total_mentions: number;

  // Current state (last 7 days)
  recent_mentions: number;
  days_since_last: number;
  recent_inbound: number;
  recent_outbound: number;

  // Anomalies
  velocity_change: number;        // ratio: recent rate / baseline rate (>1 = accelerating, <1 = decelerating)
  is_anomaly: boolean;
  anomaly_type: 'accelerating' | 'decelerating' | 'silent' | 'surge' | null;
  anomaly_severity: 'low' | 'medium' | 'high' | null;

  // AI interpretation (filled by DeepSeek when anomaly detected)
  interpretation: string | null;
  recommended_action: string | null;
}

// ============================================================
// Schema: entity_predictors table
// ============================================================

export function ensurePredictorSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_predictors (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      entity_name TEXT NOT NULL,
      relationship_type TEXT,

      -- 30-day baselines
      avg_mentions_per_week REAL DEFAULT 0,
      avg_gap_days REAL DEFAULT 0,
      inbound_ratio REAL DEFAULT 0,
      total_mentions INTEGER DEFAULT 0,

      -- Current state (last 7 days)
      recent_mentions INTEGER DEFAULT 0,
      days_since_last REAL DEFAULT 0,
      recent_inbound INTEGER DEFAULT 0,
      recent_outbound INTEGER DEFAULT 0,

      -- Anomaly detection
      velocity_change REAL DEFAULT 1.0,
      is_anomaly INTEGER DEFAULT 0,
      anomaly_type TEXT,
      anomaly_severity TEXT,

      -- AI interpretation
      interpretation TEXT,
      recommended_action TEXT,

      computed_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_predictors_anomaly ON entity_predictors(is_anomaly);
    CREATE INDEX IF NOT EXISTS idx_predictors_severity ON entity_predictors(anomaly_severity);
  `);
}

// ============================================================
// Compute predictions from entity_mentions data
// ============================================================

export async function computePredictions(
  db: Database.Database,
  options: { verbose?: boolean; interpret?: boolean } = {}
): Promise<{ computed: number; anomalies: number; interpreted: number }> {
  const log = options.verbose ? console.log : () => {};
  ensurePredictorSchema(db);

  const stats = { computed: 0, anomalies: 0, interpreted: 0 };

  // Get all non-dismissed entities with at least 3 mentions
  const entities = db.prepare(`
    SELECT e.id, e.canonical_name, e.relationship_type, e.user_label,
           COUNT(em.id) as mention_count
    FROM entities e
    JOIN entity_mentions em ON em.entity_id = e.id
    WHERE e.user_dismissed = 0
      AND e.type = 'person'
      AND e.canonical_name != 'Zach Stock'
    GROUP BY e.id
    HAVING mention_count >= 3
    ORDER BY mention_count DESC
  `).all() as any[];

  log(`  Computing predictions for ${entities.length} entities...`);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

  // Prepared statements for efficiency
  const baseline30d = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as inbound,
      COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as outbound,
      MIN(mention_date) as first_date,
      MAX(mention_date) as last_date
    FROM entity_mentions
    WHERE entity_id = ? AND mention_date >= ?
  `);

  const recent7d = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as inbound,
      COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as outbound
    FROM entity_mentions
    WHERE entity_id = ? AND mention_date >= ?
  `);

  const lastMention = db.prepare(`
    SELECT MAX(mention_date) as last_date
    FROM entity_mentions
    WHERE entity_id = ?
  `);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO entity_predictors
    (entity_id, entity_name, relationship_type,
     avg_mentions_per_week, avg_gap_days, inbound_ratio, total_mentions,
     recent_mentions, days_since_last, recent_inbound, recent_outbound,
     velocity_change, is_anomaly, anomaly_type, anomaly_severity,
     interpretation, recommended_action, computed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  const anomalies: EntityPrediction[] = [];

  for (const entity of entities) {
    // 30-day baseline
    const b = baseline30d.get(entity.id, thirtyDaysAgo) as any;
    // 7-day recent
    const r = recent7d.get(entity.id, sevenDaysAgo) as any;
    // Last contact
    const last = lastMention.get(entity.id) as any;

    const totalMentions30d = b?.total || 0;
    const recentMentions7d = r?.total || 0;

    // Compute baselines
    const weeksInRange = 4.3; // ~30 days
    const avgPerWeek = totalMentions30d / weeksInRange;
    const recentPerWeek = recentMentions7d; // 7 days = 1 week

    // Average gap between mentions
    let avgGap = 0;
    if (b?.first_date && b?.last_date && totalMentions30d > 1) {
      const rangeMs = new Date(b.last_date).getTime() - new Date(b.first_date).getTime();
      avgGap = (rangeMs / 86400000) / (totalMentions30d - 1);
    }

    // Inbound ratio
    const inboundRatio = totalMentions30d > 0 ? (b?.inbound || 0) / totalMentions30d : 0;

    // Days since last contact
    const daysSinceLast = last?.last_date
      ? (now.getTime() - new Date(last.last_date).getTime()) / 86400000
      : 999;

    // Velocity change: recent rate / baseline rate
    const velocityChange = avgPerWeek > 0 ? recentPerWeek / avgPerWeek : (recentMentions7d > 0 ? 2.0 : 0);

    // Anomaly detection
    let isAnomaly = false;
    let anomalyType: EntityPrediction['anomaly_type'] = null;
    let anomalySeverity: EntityPrediction['anomaly_severity'] = null;

    if (avgPerWeek >= 1) {
      // Active entity — check for significant changes
      if (velocityChange < 0.3 && daysSinceLast > avgGap * 2) {
        // Communication dropped >70% AND gap is 2x normal
        isAnomaly = true;
        anomalyType = 'decelerating';
        anomalySeverity = daysSinceLast > avgGap * 3 ? 'high' : 'medium';
      } else if (velocityChange > 2.5) {
        // Sudden surge — 2.5x normal rate
        isAnomaly = true;
        anomalyType = 'surge';
        anomalySeverity = velocityChange > 4 ? 'high' : 'medium';
      } else if (daysSinceLast > 14 && avgPerWeek >= 2) {
        // Was very active (2+/week), now silent for 2+ weeks
        isAnomaly = true;
        anomalyType = 'silent';
        anomalySeverity = daysSinceLast > 21 ? 'high' : 'medium';
      }
    } else if (entity.mention_count >= 5 && daysSinceLast > 30) {
      // Semi-active entity gone completely silent
      isAnomaly = true;
      anomalyType = 'silent';
      anomalySeverity = 'low';
    }

    const prediction: EntityPrediction = {
      entity_id: entity.id,
      entity_name: entity.canonical_name,
      relationship_type: entity.user_label || entity.relationship_type,
      avg_mentions_per_week: Math.round(avgPerWeek * 10) / 10,
      avg_gap_days: Math.round(avgGap * 10) / 10,
      inbound_ratio: Math.round(inboundRatio * 100) / 100,
      total_mentions: entity.mention_count,
      recent_mentions: recentMentions7d,
      days_since_last: Math.round(daysSinceLast * 10) / 10,
      recent_inbound: r?.inbound || 0,
      recent_outbound: r?.outbound || 0,
      velocity_change: Math.round(velocityChange * 100) / 100,
      is_anomaly: isAnomaly,
      anomaly_type: anomalyType,
      anomaly_severity: anomalySeverity,
      interpretation: null,
      recommended_action: null,
    };

    upsert.run(
      prediction.entity_id, prediction.entity_name, prediction.relationship_type,
      prediction.avg_mentions_per_week, prediction.avg_gap_days, prediction.inbound_ratio, prediction.total_mentions,
      prediction.recent_mentions, prediction.days_since_last, prediction.recent_inbound, prediction.recent_outbound,
      prediction.velocity_change, prediction.is_anomaly ? 1 : 0, prediction.anomaly_type, prediction.anomaly_severity,
      null, null // interpretation and action filled later
    );

    stats.computed++;
    if (isAnomaly) {
      anomalies.push(prediction);
      stats.anomalies++;
    }
  }

  log(`  ${stats.computed} entities computed, ${stats.anomalies} anomalies detected`);

  // Interpret anomalies with DeepSeek Reasoner (batch)
  if (options.interpret !== false && anomalies.length > 0) {
    log(`  Interpreting ${anomalies.length} anomalies with AI...`);

    try {
      const apiKey = getConfig(db, 'openai_api_key');
      const provider = await getBulkProvider(apiKey || undefined);

      // Batch in groups of 10 to avoid JSON parse issues with large responses
      for (let batch = 0; batch < anomalies.length; batch += 10) {
        const batchAnomalies = anomalies.slice(batch, batch + 10);
      const anomalyText = batchAnomalies.map((a, i) => {
        return `[${i}] ${a.entity_name} (${a.relationship_type || 'unknown'})
  Anomaly: ${a.anomaly_type} (${a.anomaly_severity})
  Baseline: ${a.avg_mentions_per_week}/week, avg ${a.avg_gap_days} day gap, ${Math.round(a.inbound_ratio * 100)}% inbound
  Recent: ${a.recent_mentions} mentions last 7d (${a.recent_inbound} in, ${a.recent_outbound} out)
  Last contact: ${a.days_since_last} days ago
  Velocity: ${a.velocity_change}x baseline`;
      }).join('\n\n');

      const response = await provider.chat(
        [
          {
            role: 'system',
            content: `You are analyzing communication anomalies for a solo insurance entrepreneur (Zach Stock, Recapture Insurance / Carefront MGA). For each anomaly, provide:
1. A one-sentence interpretation of what the pattern means
2. A specific recommended action (not generic — name the person, suggest the email subject line or call topic)

Consider:
- "employee" entities going silent may mean they're overwhelmed or blocking on something
- "partner" entities decelerating may signal deal fatigue or competing priorities
- Surges may mean urgency, a crisis, or a deal heating up
- The action should match the anomaly — don't suggest a formal email when a casual "hey, how's it going?" is better

Return JSON: {"interpretations": [{"index": 0, "interpretation": "...", "action": "..."}]}`,
          },
          { role: 'user', content: anomalyText },
        ],
        { temperature: 0.2, max_tokens: 4000, json: true }
      );

      const result = JSON.parse(response);
      const interps = result.interpretations || [];

      const updateInterp = db.prepare(
        'UPDATE entity_predictors SET interpretation = ?, recommended_action = ?, updated_at = datetime(\'now\') WHERE entity_id = ?'
      );

      for (const interp of interps) {
        const anomaly = batchAnomalies[interp.index];
        if (anomaly && interp.interpretation) {
          updateInterp.run(interp.interpretation, interp.action || null, anomaly.entity_id);
          stats.interpreted++;
        }
      }
      } // end batch loop

      log(`  ${stats.interpreted} anomalies interpreted`);
    } catch (err: any) {
      log(`  ⚠ Interpretation failed: ${err.message?.slice(0, 80)}`);
    }
  }

  return stats;
}

// ============================================================
// Query predictions
// ============================================================

export function getAnomalies(db: Database.Database, severity?: string): EntityPrediction[] {
  ensurePredictorSchema(db);
  let sql = 'SELECT * FROM entity_predictors WHERE is_anomaly = 1';
  const params: any[] = [];
  if (severity) {
    sql += ' AND anomaly_severity = ?';
    params.push(severity);
  }
  sql += ' ORDER BY anomaly_severity DESC, velocity_change ASC';
  return db.prepare(sql).all(...params) as EntityPrediction[];
}

export function getEntityPrediction(db: Database.Database, entityName: string): EntityPrediction | null {
  ensurePredictorSchema(db);
  return db.prepare(
    'SELECT * FROM entity_predictors WHERE entity_name LIKE ?'
  ).get(`%${entityName}%`) as EntityPrediction | null;
}

export function getAllPredictions(db: Database.Database): EntityPrediction[] {
  ensurePredictorSchema(db);
  return db.prepare(
    'SELECT * FROM entity_predictors ORDER BY total_mentions DESC'
  ).all() as EntityPrediction[];
}

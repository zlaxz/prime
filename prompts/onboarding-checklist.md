# Customer Onboarding Checklist

**Customer**: {{name}} ({{email}})
**Plan**: {{plan}}
**Signup Date**: {{signup_date}}
**Target Live Date**: {{signup_date + 24h}}

---

## Infrastructure Setup (Day 0)

- [ ] Create their SQLite database (`~/.prime/customers/{{customer_id}}/prime.db`)
- [ ] Generate and deliver API key
- [ ] Set up their Gmail OAuth (requires their Google sign-in)
- [ ] Set up their Calendar sync
- [ ] Configure their MCP proxy endpoint

## Data Backfill (Day 0-1)

- [ ] Run initial 14-month email backfill (`mass-gmail-ingest`)
- [ ] Run sent mail backfill (`mass-sent-ingest`)
- [ ] Run entity graph build (dream pipeline Task 01-05)
- [ ] Run entity profile generation (dream pipeline Task 06)
- [ ] Run first dream pipeline (full — Tasks 01-21)
- [ ] Verify entity graph quality (spot-check 10 entities)
- [ ] Verify commitment detection accuracy

## Intelligence Activation (Day 1-2)

- [ ] Run first strategic briefing
- [ ] Review briefing for accuracy before sending
- [ ] Send first briefing to customer
- [ ] Create their COS identity files (customize `cos-identity.md` with their business context)
- [ ] Configure noise filter thresholds for their domain

## Customer Touchpoint (Day 2-3)

- [ ] Schedule 15-minute onboarding call
- [ ] Walk through briefing on the call
- [ ] Collect feedback on entity classification accuracy
- [ ] Apply any corrections via `prime_correct`
- [ ] Set up recurring briefing cadence (daily/weekly per preference)

## Ongoing (Week 1)

- [ ] Monitor first 3 automated briefings for quality
- [ ] Check prediction accuracy after first week
- [ ] Confirm Gmail sync running on schedule (every 15 min)
- [ ] Verify calendar events ingesting correctly
- [ ] Follow up with customer on value delivered

---

**Definition of Done**: Customer has received at least 3 briefings, entity graph has been validated, and customer has confirmed Prime is surfacing useful intelligence.

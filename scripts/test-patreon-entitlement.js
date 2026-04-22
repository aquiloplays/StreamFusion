#!/usr/bin/env node
// Offline simulator for patreon-auth.js's verifyMembership logic.
// Feeds synthetic Patreon API responses through a lightly-adapted copy
// of the production logic (the ACTUAL live code requires an access
// token + electron), then asserts the result matches expected entitled
// / tier / reason for each case.
//
// Runs the exact decision tree from patreon-auth.js @ commit 7ace82d.
// Purpose: prove that the fix actually unblocks the reported bug cases
// (null patron_status + valid pledge) without regressing happy paths
// or incorrectly granting access to declined / former patrons.
//
// Usage:  node scripts/test-patreon-entitlement.js
// Exit:   0 on all-pass, 1 on any failure.

'use strict';

// Mirror the production constants.
const PATREON_CAMPAIGN_ID = '3410750';
const PATREON_TIER_IDS = { tier2: '28147937', tier3: '28147942' };
const OWNER_EMAILS = ['bisherclay@gmail.com'];

// Synchronous port of verifyMembership's decision tree from patreon-auth.js
// @ hotfix-1.5.0.2 branch (commit fb882c0 / 7ace82d). If this logic
// changes, update this sim in lockstep.
function verifyMembership(data) {
  const userName  = (data && data.data && data.data.attributes && data.data.attributes.full_name) || '';
  const userEmail = (data && data.data && data.data.attributes && data.data.attributes.email) || '';

  if (userEmail && OWNER_EMAILS.indexOf(userEmail.toLowerCase()) !== -1) {
    return { active: true, entitled: true, tier: 'tier3', patronStatus: 'active_patron', reason: 'entitled', userName };
  }

  if (!data || !data.included) {
    return { active: false, entitled: false, tier: 'none', patronStatus: null, reason: 'no_memberships', userName };
  }

  const memberships = data.included.filter(i => i.type === 'member');
  let myMembership = null;
  for (const m of memberships) {
    const camp = m.relationships && m.relationships.campaign && m.relationships.campaign.data;
    if (camp && String(camp.id) === String(PATREON_CAMPAIGN_ID)) { myMembership = m; break; }
  }
  if (!myMembership) {
    return { active: false, entitled: false, tier: 'follower', patronStatus: null, reason: 'not_a_member', userName };
  }

  const mAttrs = myMembership.attributes || {};
  const patronStatus = mAttrs.patron_status || null;
  const amountCents = Number(mAttrs.currently_entitled_amount_cents) || 0;
  const entitledTierIds = ((myMembership.relationships
                         && myMembership.relationships.currently_entitled_tiers
                         && myMembership.relationships.currently_entitled_tiers.data) || [])
                         .map(t => String(t.id));

  const tier2Id = String(PATREON_TIER_IDS.tier2);
  const tier3Id = String(PATREON_TIER_IDS.tier3);
  let hasTier3 = entitledTierIds.indexOf(tier3Id) !== -1;
  let hasTier2 = entitledTierIds.indexOf(tier2Id) !== -1;
  if (!hasTier3 && amountCents >= 1000) hasTier3 = true;
  if (!hasTier2 && amountCents >= 600)  hasTier2 = true;

  const tier = hasTier3 ? 'tier3'
             : hasTier2 ? 'tier2'
             : (entitledTierIds.length > 0 || amountCents > 0) ? 'tier1'
             : 'follower';

  const explicitlyInactive = patronStatus === 'declined_patron' || patronStatus === 'former_patron';
  const entitled = (hasTier2 || hasTier3) && !explicitlyInactive;
  const active = patronStatus === 'active_patron' || entitled;

  let reason;
  if (entitled) reason = 'entitled';
  else if (explicitlyInactive) reason = patronStatus;
  else if (amountCents === 0 && entitledTierIds.length === 0) reason = 'follower';
  else reason = 'insufficient_tier';

  return { active, entitled, tier, patronStatus, reason, userName };
}

// ─── Scenario builders ─────────────────────────────────────────────────
function mkResponse(opts) {
  // opts = { email, name, memberships: [{ campaignId, patronStatus, amountCents, tierIds }] }
  const included = [];
  for (const m of (opts.memberships || [])) {
    included.push({
      type: 'member',
      id: 'member-' + Math.random().toString(36).slice(2),
      attributes: {
        patron_status: m.patronStatus === undefined ? null : m.patronStatus,
        currently_entitled_amount_cents: m.amountCents == null ? 0 : m.amountCents
      },
      relationships: {
        campaign: { data: { id: String(m.campaignId || PATREON_CAMPAIGN_ID), type: 'campaign' } },
        currently_entitled_tiers: { data: (m.tierIds || []).map(id => ({ id: String(id), type: 'tier' })) }
      }
    });
  }
  return {
    data: { attributes: { full_name: opts.name || 'Test User', email: opts.email || '' } },
    included: opts.memberships === undefined ? undefined : included
  };
}

// ─── Scenarios ─────────────────────────────────────────────────────────
const scenarios = [
  {
    name: 'Happy path: active Tier 2 with full tier-ID + amount',
    input: mkResponse({ email: 'happy-t2@example.com', memberships: [{
      patronStatus: 'active_patron', amountCents: 600, tierIds: ['28147937']
    }]}),
    expect: { entitled: true, tier: 'tier2', reason: 'entitled' }
  },
  {
    name: 'Happy path: active Tier 3 with full tier-ID + amount',
    input: mkResponse({ email: 'happy-t3@example.com', memberships: [{
      patronStatus: 'active_patron', amountCents: 1000, tierIds: ['28147942']
    }]}),
    expect: { entitled: true, tier: 'tier3', reason: 'entitled' }
  },
  {
    name: 'BUG CASE (itstojuo-class): new Tier 2 pledge, null status, tier-ID present',
    input: mkResponse({ email: 'itstojuo@example.com', memberships: [{
      patronStatus: null, amountCents: 600, tierIds: ['28147937']
    }]}),
    expect: { entitled: true, tier: 'tier2', reason: 'entitled' }
  },
  {
    name: 'BUG CASE (Apple relay): null status, EMPTY tier-IDs, amount 600',
    input: mkResponse({ email: 'wtnjb7nqfq@privaterelay.appleid.com', memberships: [{
      patronStatus: null, amountCents: 600, tierIds: []
    }]}),
    expect: { entitled: true, tier: 'tier2', reason: 'entitled' }
  },
  {
    name: 'BUG CASE: Tier 3 with null status, empty tier-IDs, amount 1000',
    input: mkResponse({ email: 'new-t3@example.com', memberships: [{
      patronStatus: null, amountCents: 1000, tierIds: []
    }]}),
    expect: { entitled: true, tier: 'tier3', reason: 'entitled' }
  },
  {
    name: 'REGRESSION GUARD: former_patron with zero amount → blocked',
    input: mkResponse({ email: 'former@example.com', memberships: [{
      patronStatus: 'former_patron', amountCents: 0, tierIds: []
    }]}),
    expect: { entitled: false, reason: 'former_patron' }
  },
  {
    name: 'REGRESSION GUARD: declined_patron should be blocked even if amount is non-zero',
    input: mkResponse({ email: 'declined@example.com', memberships: [{
      patronStatus: 'declined_patron', amountCents: 600, tierIds: ['28147937']
    }]}),
    expect: { entitled: false, reason: 'declined_patron' }
  },
  {
    name: 'REGRESSION GUARD: Tier 1 ($3 Supporter) should NOT be entitled',
    input: mkResponse({ email: 't1@example.com', memberships: [{
      patronStatus: 'active_patron', amountCents: 300, tierIds: ['28135308']
    }]}),
    expect: { entitled: false, tier: 'tier1', reason: 'insufficient_tier' }
  },
  {
    name: 'REGRESSION GUARD: free follower (tier=Free, amount=0) blocked',
    input: mkResponse({ email: 'free@example.com', memberships: [{
      patronStatus: null, amountCents: 0, tierIds: ['13735250']
    }]}),
    expect: { entitled: false, tier: 'tier1', reason: 'insufficient_tier' }
  },
  {
    name: 'REGRESSION GUARD: owner bypass still works',
    input: mkResponse({ email: 'bisherclay@gmail.com', memberships: [{
      patronStatus: null, amountCents: 0, tierIds: []
    }]}),
    expect: { entitled: true, tier: 'tier3', reason: 'entitled' }
  },
  {
    name: 'REGRESSION GUARD: owner bypass is case-insensitive',
    input: mkResponse({ email: 'BisherClay@Gmail.com', memberships: [{
      patronStatus: null, amountCents: 0, tierIds: []
    }]}),
    expect: { entitled: true, tier: 'tier3', reason: 'entitled' }
  },
  {
    name: 'REGRESSION GUARD: user with memberships but none on our campaign',
    input: mkResponse({ email: 'other-creator-patron@example.com', memberships: [{
      campaignId: '999999', patronStatus: 'active_patron', amountCents: 600, tierIds: ['xxx']
    }]}),
    expect: { entitled: false, tier: 'follower', reason: 'not_a_member' }
  },
  {
    name: 'REGRESSION GUARD: response with no `included` at all (scope issue)',
    input: { data: { attributes: { full_name: 'Scope Issue', email: 's@example.com' } } },
    expect: { entitled: false, tier: 'none', reason: 'no_memberships' }
  },
  {
    name: 'EDGE: integer campaign ID (JSONAPI client quirk) still matches',
    input: (() => {
      const r = mkResponse({ email: 'intid@example.com', memberships: [{
        patronStatus: 'active_patron', amountCents: 600, tierIds: ['28147937']
      }]});
      // Simulate the edge where some client deserialized IDs as integers
      r.included[0].relationships.campaign.data.id = 3410750;
      return r;
    })(),
    expect: { entitled: true, tier: 'tier2', reason: 'entitled' }
  },
  {
    name: 'EDGE: "pending" or unknown custom patron_status still grants if paying',
    input: mkResponse({ email: 'pending@example.com', memberships: [{
      patronStatus: 'pending', amountCents: 1000, tierIds: ['28147942']
    }]}),
    expect: { entitled: true, tier: 'tier3', reason: 'entitled' }
  },
  {
    name: 'EDGE: Tier 2 with amount 599 (just under threshold) → Tier 1',
    input: mkResponse({ email: 'underpay@example.com', memberships: [{
      patronStatus: 'active_patron', amountCents: 599, tierIds: []
    }]}),
    expect: { entitled: false, tier: 'tier1', reason: 'insufficient_tier' }
  }
];

// ─── Runner ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const s of scenarios) {
  const got = verifyMembership(s.input);
  const keys = Object.keys(s.expect);
  const mismatches = keys.filter(k => got[k] !== s.expect[k]);
  const ok = mismatches.length === 0;
  if (ok) {
    pass++;
    console.log('PASS │ ' + s.name);
  } else {
    fail++;
    console.log('FAIL │ ' + s.name);
    console.log('     │   expected: ' + JSON.stringify(s.expect));
    console.log('     │   got:      ' + JSON.stringify({ entitled: got.entitled, tier: got.tier, reason: got.reason, active: got.active, patronStatus: got.patronStatus }));
  }
}

console.log('\n' + pass + ' pass, ' + fail + ' fail, ' + scenarios.length + ' total');
process.exit(fail === 0 ? 0 : 1);

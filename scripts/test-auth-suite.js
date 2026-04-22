#!/usr/bin/env node
// Comprehensive auth-path test suite for StreamFusion.
//
// Covers all four decision layers:
//   1. patreon-auth.js verifyMembership      (Patreon /identity → tier + entitled)
//   2. discord-auth.js verifyMembership      (Discord guild member → tier + entitled)
//   3. renderer _recomputeCombinedEntitlement (S.hasEarlyAccess = union)
//   4. renderer _sfBetaGateSync              (is beta Tier 3 gate open?)
//
// Each layer is ported from the production code line-for-line (minus the
// electron / network calls) so the logic tested here IS the logic that
// runs in-app. When you change an auth file, re-port the matching block
// below and re-run this suite.
//
// Every realistic patron class gets a scenario:
//   - Tier 2 active patron (Patreon only)
//   - Tier 3 active patron (Patreon only)
//   - Tier 2 with `null` patron_status (new pledge / Apple relay)
//   - Tier 3 with `null` patron_status
//   - Tier 2 via Discord role only (no Patreon)
//   - Tier 3 via Discord role only
//   - Tier 2 via both paths
//   - Tier 3 via both paths
//   - Patreon tier2 + Discord tier3 (upgrade through Discord)
//   - Declined / former patrons rejected
//   - Non-patron rejected
//
// Usage:  node scripts/test-auth-suite.js
// Exit:   0 on all-pass, 1 on any failure.

'use strict';

// ─── Shared constants (mirror production) ─────────────────────────────
const PATREON_CAMPAIGN_ID = '3410750';
const PATREON_TIER_IDS = { tier2: '28147937', tier3: '28147942' };
const OWNER_EMAILS = ['bisherclay@gmail.com'];
const DISCORD_GUILD_ID = '1334146273854619709';
const DISCORD_ROLE_IDS = { tier2: '1482092449609420982', tier3: '1483242263961407670' };

// ═══════════════════════════════════════════════════════════════════════
// LAYER 1 — Patreon verifyMembership
// Ported from patreon-auth.js @ commit ec14518 (post-1.5.1 entitlement fix)
// ═══════════════════════════════════════════════════════════════════════
function verifyPatreonMembership(data) {
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

// ═══════════════════════════════════════════════════════════════════════
// LAYER 2 — Discord verifyMembership
// Ported from discord-auth.js @ commit ec14518
// ═══════════════════════════════════════════════════════════════════════
function verifyDiscordMembership({ me, member, memberFetchError }) {
  const userName = (me && (me.global_name || me.username)) || '';
  const userId   = (me && me.id) || '';

  if (memberFetchError === 'not_in_guild') {
    return { active: false, entitled: false, tier: 'none', reason: 'not_in_guild', userName, userId };
  }

  let roleIds = (member && member.roles) || [];
  if (!Array.isArray(roleIds)) roleIds = [];
  roleIds = roleIds.map(r => String(r));

  const tier3Id = String(DISCORD_ROLE_IDS.tier3);
  const tier2Id = String(DISCORD_ROLE_IDS.tier2);
  const hasTier3 = roleIds.indexOf(tier3Id) !== -1;
  const hasTier2 = roleIds.indexOf(tier2Id) !== -1;

  const tier = hasTier3 ? 'tier3' : hasTier2 ? 'tier2' : 'none';
  const entitled = hasTier2 || hasTier3;
  const reason = entitled ? 'entitled' : 'no_role';

  return { active: entitled, entitled, tier, reason, userName, userId };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 3 — Combined entitlement (renderer union)
// Ported from _recomputeCombinedEntitlement in index.html
// ═══════════════════════════════════════════════════════════════════════
function recomputeCombinedEntitlement(S) {
  const patreonOk = !!(S.patreon && S.patreon.entitled);
  const discordOk = !!(S.discord && S.discord.entitled);
  return patreonOk || discordOk;
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 4 — Beta Tier 3 gate
// Ported from _sfBetaGateSync in index.html
// Returns true if the gate is HIDDEN (user unlocked), false if BLOCKED.
// ═══════════════════════════════════════════════════════════════════════
function betaGateOpen(S, isBetaInstall) {
  if (!isBetaInstall) return true;  // gate doesn't exist on stable

  const patreonOk = !!(S.patreon && S.patreon.entitled);
  const discordOk = !!(S.discord && S.discord.entitled);

  // Pick which state drives the gate message (prefer tier3 source).
  let gateState;
  if (patreonOk && S.patreon.tier === 'tier3') gateState = S.patreon;
  else if (discordOk && S.discord.tier === 'tier3') gateState = {
    signedIn: true, entitled: true, tier: 'tier3',
    userName: S.discord.userName, reason: 'entitled'
  };
  else gateState = S.patreon;

  return !!(gateState && gateState.entitled && gateState.tier === 'tier3');
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario builders
// ═══════════════════════════════════════════════════════════════════════
function mkPatreonResp(opts) {
  const included = [];
  for (const m of (opts.memberships || [])) {
    included.push({
      type: 'member',
      id: 'm-' + Math.random().toString(36).slice(2),
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
    data: { attributes: { full_name: opts.name || 'Test', email: opts.email || '' } },
    included: opts.memberships === undefined ? undefined : included
  };
}

function mkDiscordResp(opts) {
  if (opts.notInGuild) {
    return {
      me: { id: opts.userId || '100', global_name: opts.name || 'Test', username: opts.name || 'Test' },
      member: null,
      memberFetchError: 'not_in_guild'
    };
  }
  return {
    me: { id: opts.userId || '100', global_name: opts.name || 'Test', username: opts.name || 'Test' },
    member: { roles: (opts.roleIds || []).map(String) }
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario matrix
// ═══════════════════════════════════════════════════════════════════════
const scenarios = [];

// ── LAYER 1 tests (Patreon) ───────────────────────────────────────────
scenarios.push(
  { layer: 'patreon', name: 'Patreon happy-path: Tier 2 active_patron',
    input: { patreon: mkPatreonResp({ email: 't2@x.com', memberships: [{ patronStatus: 'active_patron', amountCents: 600, tierIds: ['28147937'] }] }) },
    expect: { entitled: true, tier: 'tier2' } },
  { layer: 'patreon', name: 'Patreon happy-path: Tier 3 active_patron',
    input: { patreon: mkPatreonResp({ email: 't3@x.com', memberships: [{ patronStatus: 'active_patron', amountCents: 1000, tierIds: ['28147942'] }] }) },
    expect: { entitled: true, tier: 'tier3' } },
  { layer: 'patreon', name: 'Patreon bug case: Tier 2 with null status + tier-ID',
    input: { patreon: mkPatreonResp({ email: 'itstojuo@x.com', memberships: [{ patronStatus: null, amountCents: 600, tierIds: ['28147937'] }] }) },
    expect: { entitled: true, tier: 'tier2' } },
  { layer: 'patreon', name: 'Patreon bug case: Tier 2 Apple-relay (null status, empty tier-IDs, amount=600)',
    input: { patreon: mkPatreonResp({ email: 'wtnjb7nqfq@privaterelay.appleid.com', memberships: [{ patronStatus: null, amountCents: 600, tierIds: [] }] }) },
    expect: { entitled: true, tier: 'tier2' } },
  { layer: 'patreon', name: 'Patreon bug case: Tier 3 Apple-relay (null status, empty tier-IDs, amount=1000)',
    input: { patreon: mkPatreonResp({ email: 'newt3@privaterelay.appleid.com', memberships: [{ patronStatus: null, amountCents: 1000, tierIds: [] }] }) },
    expect: { entitled: true, tier: 'tier3' } },
  { layer: 'patreon', name: 'Patreon rejected: former_patron',
    input: { patreon: mkPatreonResp({ email: 'ex@x.com', memberships: [{ patronStatus: 'former_patron', amountCents: 0, tierIds: [] }] }) },
    expect: { entitled: false } },
  { layer: 'patreon', name: 'Patreon rejected: declined_patron (even with amount set)',
    input: { patreon: mkPatreonResp({ email: 'declined@x.com', memberships: [{ patronStatus: 'declined_patron', amountCents: 600, tierIds: ['28147937'] }] }) },
    expect: { entitled: false } },
  { layer: 'patreon', name: 'Patreon rejected: Tier 1 supporter ($3)',
    input: { patreon: mkPatreonResp({ email: 't1@x.com', memberships: [{ patronStatus: 'active_patron', amountCents: 300, tierIds: ['28135308'] }] }) },
    expect: { entitled: false, tier: 'tier1' } },
  { layer: 'patreon', name: 'Patreon owner bypass always grants tier3',
    input: { patreon: mkPatreonResp({ email: 'bisherclay@gmail.com', memberships: [{ patronStatus: null, amountCents: 0, tierIds: [] }] }) },
    expect: { entitled: true, tier: 'tier3' } },
);

// ── LAYER 2 tests (Discord) ───────────────────────────────────────────
scenarios.push(
  { layer: 'discord', name: 'Discord happy-path: Tier 2 Patron role',
    input: { discord: mkDiscordResp({ name: 't2', roleIds: ['1482092449609420982', '9999999999999'] }) },
    expect: { entitled: true, tier: 'tier2' } },
  { layer: 'discord', name: 'Discord happy-path: Tier 3 Patron role',
    input: { discord: mkDiscordResp({ name: 't3', roleIds: ['1483242263961407670'] }) },
    expect: { entitled: true, tier: 'tier3' } },
  { layer: 'discord', name: 'Discord: Tier 3 takes precedence when user has BOTH roles',
    input: { discord: mkDiscordResp({ name: 'dual', roleIds: ['1482092449609420982', '1483242263961407670'] }) },
    expect: { entitled: true, tier: 'tier3' } },
  { layer: 'discord', name: 'Discord rejected: no Patron role',
    input: { discord: mkDiscordResp({ name: 'bystander', roleIds: ['12345', '67890'] }) },
    expect: { entitled: false, tier: 'none' } },
  { layer: 'discord', name: 'Discord rejected: not in guild',
    input: { discord: mkDiscordResp({ name: 'outsider', notInGuild: true }) },
    expect: { entitled: false, tier: 'none' } },
  // NOTE: Can't test "integer role IDs" scenario in JS — Discord snowflakes
  // are 19-digit integers that exceed Number.MAX_SAFE_INTEGER (16 digits),
  // so writing `[1482092449609420982]` as a JS literal silently corrupts
  // to `1482092449609421000` before the code under test runs. Not a
  // problem in production because Discord's API sends role IDs as strings
  // per JSONAPI spec — we'd need to manufacture a malformed response to
  // hit this. Production code uses `String(r)` defensively anyway.
);

// ── LAYER 3 tests (Combined entitlement union) ────────────────────────
scenarios.push(
  { layer: 'combined', name: 'Combined: entitled via Patreon only (Discord not connected)',
    input: { S: { patreon: { entitled: true, tier: 'tier2' }, discord: { entitled: false, tier: 'none' } } },
    expect: { entitled: true } },
  { layer: 'combined', name: 'Combined: entitled via Discord only (Patreon blocked / not connected)',
    input: { S: { patreon: { entitled: false, tier: 'none' }, discord: { entitled: true, tier: 'tier2' } } },
    expect: { entitled: true } },
  { layer: 'combined', name: 'Combined: entitled via BOTH (Tier 2 everywhere)',
    input: { S: { patreon: { entitled: true, tier: 'tier2' }, discord: { entitled: true, tier: 'tier2' } } },
    expect: { entitled: true } },
  { layer: 'combined', name: 'Combined: NOT entitled when both sources reject',
    input: { S: { patreon: { entitled: false, tier: 'follower' }, discord: { entitled: false, tier: 'none' } } },
    expect: { entitled: false } },
  { layer: 'combined', name: 'Combined: entitled when Apple-relay Patreon broken, Discord role present',
    input: { S: { patreon: { entitled: false, tier: 'none', reason: 'reverify_failed' }, discord: { entitled: true, tier: 'tier2' } } },
    expect: { entitled: true } },
);

// ── LAYER 4 tests (Beta Tier 3 gate) ──────────────────────────────────
scenarios.push(
  { layer: 'beta-gate', name: 'Beta gate OPEN: Tier 3 via Patreon',
    input: { S: { patreon: { entitled: true, tier: 'tier3' }, discord: { entitled: false, tier: 'none' } }, isBeta: true },
    expect: { open: true } },
  { layer: 'beta-gate', name: 'Beta gate OPEN: Tier 3 via Discord (Patreon broken)',
    input: { S: { patreon: { entitled: false, tier: 'none' }, discord: { entitled: true, tier: 'tier3', userName: 'p3' } }, isBeta: true },
    expect: { open: true } },
  { layer: 'beta-gate', name: 'Beta gate OPEN: Tier 3 via Discord, Tier 2 via Patreon (upgrade-via-Discord)',
    input: { S: { patreon: { entitled: true, tier: 'tier2' }, discord: { entitled: true, tier: 'tier3', userName: 'p3' } }, isBeta: true },
    expect: { open: true } },
  { layer: 'beta-gate', name: 'Beta gate BLOCKED: Tier 2 everywhere (no Tier 3 anywhere)',
    input: { S: { patreon: { entitled: true, tier: 'tier2' }, discord: { entitled: true, tier: 'tier2' } }, isBeta: true },
    expect: { open: false } },
  { layer: 'beta-gate', name: 'Beta gate BLOCKED: non-patron',
    input: { S: { patreon: { entitled: false, tier: 'follower' }, discord: { entitled: false, tier: 'none' } }, isBeta: true },
    expect: { open: false } },
  { layer: 'beta-gate', name: 'Beta gate N/A: non-beta install (always open)',
    input: { S: { patreon: { entitled: false }, discord: { entitled: false } }, isBeta: false },
    expect: { open: true } },
);

// ═══════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════
let pass = 0, fail = 0;
for (const s of scenarios) {
  let got;
  if (s.layer === 'patreon') {
    got = verifyPatreonMembership(s.input.patreon);
  } else if (s.layer === 'discord') {
    got = verifyDiscordMembership(s.input.discord);
  } else if (s.layer === 'combined') {
    got = { entitled: recomputeCombinedEntitlement(s.input.S) };
  } else if (s.layer === 'beta-gate') {
    got = { open: betaGateOpen(s.input.S, s.input.isBeta) };
  }
  const keys = Object.keys(s.expect);
  const mismatches = keys.filter(k => got[k] !== s.expect[k]);
  const ok = mismatches.length === 0;
  if (ok) {
    pass++;
    console.log('PASS │ [' + s.layer.padEnd(9) + '] ' + s.name);
  } else {
    fail++;
    console.log('FAIL │ [' + s.layer.padEnd(9) + '] ' + s.name);
    console.log('     │   expected: ' + JSON.stringify(s.expect));
    console.log('     │   got:      ' + JSON.stringify(got));
  }
}

const byLayer = scenarios.reduce((a, s) => { a[s.layer] = (a[s.layer] || 0) + 1; return a; }, {});
console.log('');
console.log('Per-layer counts: ' + Object.entries(byLayer).map(([k, v]) => k + '=' + v).join(', '));
console.log(pass + ' pass, ' + fail + ' fail, ' + scenarios.length + ' total');
process.exit(fail === 0 ? 0 : 1);

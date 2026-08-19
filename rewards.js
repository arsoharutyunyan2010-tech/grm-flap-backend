/**
 * Weekly reward distribution.
 *
 * Call runWeeklyRewardJob(store) once per week (Monday 00:00 UTC is a
 * natural choice, matching store.currentWeekKey()). It:
 *   1. reads the just-finished week's leaderboard,
 *   2. computes GRM payouts by rank tier,
 *   3. hands them to distributeGrmRewards() for actual on-chain/DB payout,
 *   4. archives the week and clears it for the next round.
 *
 * Wire up a real scheduler in production, e.g.:
 *   const cron = require('node-cron');
 *   cron.schedule('0 0 * * 1', () => runWeeklyRewardJob(store), { timezone: 'UTC' });
 */

const REWARD_TIERS = [
  { fromRank: 1, toRank: 1, grm: 500 },
  { fromRank: 2, toRank: 2, grm: 300 },
  { fromRank: 3, toRank: 3, grm: 150 },
  { fromRank: 4, toRank: 10, grm: 50 },
  { fromRank: 11, toRank: 25, grm: 20 },
];

function grmForRank(rank) {
  const tier = REWARD_TIERS.find(t => rank >= t.fromRank && rank <= t.toRank);
  return tier ? tier.grm : 0;
}

/**
 * Actually send GRM to winners. This is a stub — plug in your real
 * payment/blockchain integration here (e.g. a GRM ledger service, an
 * on-chain transfer, or a manual-approval payout queue). Keep it
 * idempotent: payouts should be safe to retry without double-paying.
 */
function distributeGrmRewards(payouts) {
  payouts.forEach(p => {
    // TODO: replace with real transfer call, e.g.:
    // await grmLedger.credit(p.userId, p.grm, { reason: `weekly-reward:${p.weekKey}:rank${p.rank}` });
    console.log(`[rewards] would pay ${p.grm} GRM to user ${p.userId} (rank #${p.rank}, score ${p.score})`);
  });
  return payouts;
}

function runWeeklyRewardJob(store, weekKeyOverride) {
  const weekKey = weekKeyOverride || store.currentWeekKey();
  const { ranked } = store.getLeaderboard(weekKey, Infinity);

  const payouts = ranked
    .map(e => ({ ...e, weekKey, grm: grmForRank(e.rank) }))
    .filter(p => p.grm > 0);

  distributeGrmRewards(payouts);
  store.archiveWeek(weekKey, payouts);

  return { weekKey, paidOut: payouts.length, payouts };
}

module.exports = { REWARD_TIERS, grmForRank, distributeGrmRewards, runWeeklyRewardJob };

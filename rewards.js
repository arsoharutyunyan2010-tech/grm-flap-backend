/**
 * Weekly reward distribution.
 *
 * Call runWeeklyRewardJob(store) once per week (Monday 00:00 UTC is a
 * natural choice, matching store.currentWeekKey()). It:
 *   1. reads the just-finished week's leaderboard,
 *   2. computes GRM payouts by rank tier,
 *   3. credits each winner's balance (visible in Profile/Wallet),
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
 * Credits each winner's GRM balance. The actual TON payout happens
 * later, manually, when the player submits a withdrawal request from
 * the Wallet tab and the admin sends it — this function just makes the
 * GRM show up as spendable balance.
 */
function distributeGrmRewards(payouts, store) {
  payouts.forEach(p => {
    if (store) store.creditBalance(p.userId, p.grm);
    console.log(`[rewards] credited ${p.grm} GRM to user ${p.userId} (rank #${p.rank}, score ${p.score})`);
  });
  return payouts;
}

function runWeeklyRewardJob(store, weekKeyOverride) {
  const weekKey = weekKeyOverride || store.currentWeekKey();
  const { ranked } = store.getLeaderboard(weekKey, Infinity);

  const payouts = ranked
    .map(e => ({ ...e, weekKey, grm: grmForRank(e.rank) }))
    .filter(p => p.grm > 0);

  distributeGrmRewards(payouts, store);
  store.archiveWeek(weekKey, payouts);

  return { weekKey, paidOut: payouts.length, payouts };
}

module.exports = { REWARD_TIERS, grmForRank, distributeGrmRewards, runWeeklyRewardJob };

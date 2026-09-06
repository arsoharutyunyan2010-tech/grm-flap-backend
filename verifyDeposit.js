/**
 * GRM FLAP — server-side on-chain verification of a deposit claim.
 * ------------------------------------------------------------------------
 * WHY: previously `/api/deposit` accepted a client-supplied `txHash` or a
 * signed TON BOC and only checked its FORMAT. Nothing proved that a real
 * inbound transfer to the project's deposit address actually exists for that
 * hash. So an attacker could claim "I sent $X to the deposit address" with a
 * hash/BOC of any *other* transfer and rely on an inattentive admin to approve
 * it. This module queries a TON indexer (toncenter by default) and confirms
 * that an inbound message with that hash reached the deposit address.
 *
 * IMPORTANT / opt-in: the network dependency is OFF until you set
 *   DEPOSIT_ONCHAIN_ENABLED=true        (require verification before approve)
 * and, optionally:
 *   TON_RPC_URL=https://toncenter.com/api/v2   (default)
 *   TON_API_KEY=...                      (only if the endpoint needs a key)
 *   DEPOSIT_TON_ADDRESS=...              (the real address players pay into)
 *
 * When it is NOT enabled the old manual-approval flow is preserved untouched.
 * When it IS enabled, `/internal/deposits/:id/approve` calls verifyDepositClaim()
 * and refuses to credit the account unless an inbound transfer with the claimed
 * hash is found arriving at DEPOSIT_TON_ADDRESS.
 *
 * Amount semantics: the claimed amount in the app is arbitrary C-units, so we
 * do NOT hard-enforce an exact TON value (that would need a live price feed).
 * We DO return the on-chain value + source so the admin (and /internal/deposits)
 * can eyeball it; the anti-fraud guarantee we enforce is "this exact message
 * genuinely paid into OUR address".
 */
'use strict';

let TonAddress = null;
try {
  // @ton/core provides Address.parse + eqRaw — used to compare raw addresses.
  const core = require('@ton/core');
  if (core && core.Address) TonAddress = core.Address;
} catch (e) { /* optional dep — fall back to string comparison below */ }

function asHex(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.indexOf('0x') === 0 || s.indexOf('0X') === 0) s = s.slice(2);
  // base64url message hashes (no punctuation) → decode to hex.
  if (/^[A-Za-z0-9_-]{40,}$/.test(s)) {
    try {
      const b = Buffer.from(s, 'base64');
      if (b.length === 32) s = b.toString('hex');
    } catch (e) { /* not base64 */ }
  }
  return s.toLowerCase();
}

function isHashEqual(a, b) {
  const ha = asHex(a);
  const hb = asHex(b);
  return ha.length > 0 && ha === hb;
}

// Return the list of candidate transaction hashes carried by a toncenter
// "getTransactions" result item, tolerant of either the transaction hash or the
// inbound message hash being what the client pasted.
function itemHashes(item) {
  const out = [];
  if (item && item.transaction_id && item.transaction_id.hash) out.push(item.transaction_id.hash);
  if (item && item.in_msg && item.in_msg.hash) out.push(item.in_msg.hash);
  if (item && item.in_msg && item.in_msg.body_hash) out.push(item.in_msg.body_hash);
  return out.filter(Boolean);
}

function itemValueNanoTon(item) {
  const v = item && item.in_msg && item.in_msg.value;
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function itemSource(item) {
  return (item && item.in_msg && item.in_msg.source) || '';
}

// Compare an address from the ledger to our deposit address. Prefer a raw
// address comparison (friendly vs raw forms both collapse to the same raw) when
// @ton/core is available; otherwise fall back to a tolerant string check.
function addressesEqual(a, b) {
  if (!a || !b) return false;
  const A = String(a).trim();
  const B = String(b).trim();
  if (A === B) return true;
  if (TonAddress) {
    try {
      return TonAddress.parse(A).equals(TonAddress.parse(B));
    } catch (e) { /* fall through to string compare */ }
  }
  // Very rough fallback: compare the trailing raw hex portion.
  const hexOf = (s) => (s.replace(/[^a-fA-F0-9]/g, '').toLowerCase());
  const rA = hexOf(A);
  const rB = hexOf(B);
  return rA.length >= 48 && rA === rB;
}

/**
 * Fetch the most recent transactions of an address from a toncenter-style
 * getTransactions endpoint and scan for the claimed message hash.
 *
 * @param {object} o
 * @param {string} o.txHash          claimed message/transaction hash
 * @param {string} o.depositAddress  the project's deposit address
 * @param {string} [o.rpcUrl]        default https://toncenter.com/api/v2
 * @param {string} [o.apiKey]
 * @param {number} [o.limit]         pages worth of recent txs to scan
 * @param {Function} [o.fetchImpl]   injected fetch (tests) — defaults to global.fetch
 */
async function verifyDepositClaim(o) {
  o = o || {};
  const txHash = String(o.txHash || '').trim();
  const depositAddress = String(o.depositAddress || '').trim();
  const limit = Math.max(5, Math.min(100, Number(o.limit) || 30));
  if (!txHash || txHash.length < 8 || !depositAddress) {
    return { ok: false, reason: 'on-chain verification requires a tx hash and deposit address' };
  }
  const rpcUrl = (String(o.rpcUrl || '').trim().replace(/\/+$/, '')) || 'https://toncenter.com/api/v2';
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return { ok: false, reason: 'no network transport available', error: 'ENOTRANSPORT' };
  }

  let nextLt = null;
  let scanned = 0;
  let best = null; // best candidate: same address + hash found
  let sameAddressAny = false; // some tx reached our address at all
  let foundAnyHash = false;

  // Scan several pages of the address's history until we either find the hash
  // or exhaust the recent window.
  for (let page = 0; page < 5; page++) {
    let url = `${rpcUrl}/getTransactions?address=${encodeURIComponent(depositAddress)}&limit=${limit}`;
    if (nextLt) url += '&to_lt=' + encodeURIComponent(nextLt);
    const headers = {};
    if (o.apiKey) headers['X-API-Key'] = o.apiKey;

    const resp = await fetchImpl(url, { headers, method: 'GET' });
    if (!resp || !resp.ok) {
      return {
        ok: false,
        reason: 'on-chain lookup failed',
        http: resp && resp.status ? resp.status : 0,
      };
    }
    const body = await resp.json();
    const list = body && body.ok ? (body.result || []) : (body && body.result);
    if (!Array.isArray(list) || list.length === 0) break;

    for (const item of list) {
      scanned++;
      const toAddress = item && item.in_msg && item.in_msg.destination
        ? item.in_msg.destination
        : (item && item.account);
      const toDeposit = addressesEqual(toAddress, depositAddress);
      const hashes = itemHashes(item);
      const hashHit = hashes.some((h) => isHashEqual(h, txHash));
      if (hashHit) foundAnyHash = true;
      if (toDeposit && hashHit) {
        best = {
          valueNanoTon: itemValueNanoTon(item),
          source: itemSource(item),
          toDeposit: true,
        };
        break;
      }
      if (toDeposit) sameAddressAny = true;
    }
    if (best) break;
    // Page forward using the oldest transaction id on this page (toncenter
    // paginates newest→oldest via to_lt of the last item).
    const last = list[list.length - 1];
    nextLt = last && last.transaction_id && last.transaction_id.lt;
    if (!nextLt) break;
  }

  if (best) {
    return { ok: true, found: true, valueNanoTon: best.valueNanoTon, source: best.source };
  }
  const reason = foundAnyHash && !sameAddressAny
    ? 'hash exists but was NOT paid to the deposit address'
    : 'no inbound transfer with that hash found to the deposit address';
  return { ok: false, found: false, reason, sameAddressAny, foundAnyHash, scanned };
}

module.exports = { verifyDepositClaim, _t: { asHex, isHashEqual, itemHashes, itemValueNanoTon, itemSource, addressesEqual } };

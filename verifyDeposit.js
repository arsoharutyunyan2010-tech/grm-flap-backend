/**
 * GRM FLAP — server-side on-chain verification of a deposit claim.
 * ------------------------------------------------------------------------
 * WHY: `/api/deposit` used to accept a client-supplied `txHash` or a signed
 * TON BOC and only checked its FORMAT. Nothing proved that a real inbound
 * transfer to the project's deposit address actually exists for that hash, so
 * an attacker could claim "I sent $X to the deposit address" with the hash of
 * any *other* transfer and rely on an inattentive admin to approve it.
 * This module queries a TON indexer (toncenter by default) and confirms that
 * real money reached the deposit address.
 *
 * TWO WAYS A TOP-UP IS MATCHED ON-CHAIN
 * 1. "hash"  — the claimed transaction/message hash is found among the deposit
 *              address's transactions. This is what a hand-pasted hash uses.
 * 2. "transfer" — for a payment made from a CONNECTED wallet the client sends
 *              the signed transaction BOC. Its external-message hash is NOT
 *              what lands on the deposit address: the wallet signs an external
 *              message to *itself* and the blockchain then relays the internal
 *              transfer, which carries a different hash. So instead of looking
 *              for a hash, we read the signed BOC (dest + amount + the wallet
 *              that signed it) and look for THAT transfer: an inbound internal
 *              message to the deposit address, from that wallet, for that
 *              amount, no earlier than the moment the player submitted.
 *              All four must match — an attacker cannot forge any of them
 *              without actually paying.
 *
 * TWO INDEXERS, ONE ANSWER
 * The keyless public toncenter endpoint rate-limits, and a throttled lookup
 * must not strand a payment that really arrived. Every read therefore goes
 * through `scanDepositLedger`, which tries toncenter first and falls back to
 * tonapi (its own limits, its own key) whenever the first indexer errors or
 * answers with nothing. Rows from both are normalised to one shape, and a
 * transfer's identity is derived from (sender, amount, time) — never from the
 * id a particular indexer handed out — so the same payment can never be
 * credited twice through two different providers.
 *
 * Config (all optional, sensible defaults):
 *   TON_RPC_URL=https://toncenter.com/api/v2   primary indexer to query
 *   TON_API_KEY=...                            only if the endpoint needs one
 *   TONAPI_URL=https://tonapi.io/v2            fallback indexer
 *   TONAPI_KEY=...                             optional tonapi bearer token
 *   DEPOSIT_TON_ADDRESS=...                    the address players pay into
 *
 * Amount semantics: the app quotes C-units, so the on-chain value is compared
 * against the value inside the SIGNED transaction (exact, up to a small
 * tolerance) rather than against the claimed C amount.
 */
'use strict';

let TonCore = null;
try {
  // @ton/core provides Address.parse/eq plus the cell parsers used to read a
  // signed transaction BOC. Optional — the hash flow works without it.
  TonCore = require('@ton/core');
} catch (e) { /* optional dep — hash-only verification below */ }
const TonAddress = TonCore && TonCore.Address ? TonCore.Address : null;

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

function itemUtime(item) {
  const u = Number(item && item.utime);
  return Number.isFinite(u) && u > 0 ? u : 0;
}

// Stable identity of a ledger row, so one transfer can only ever pay for one
// top-up request (see spentTransfers in server.js).
function itemTxId(item) {
  const t = item && item.transaction_id;
  if (t && t.hash) return asHex(t.hash);
  if (t && t.lt) return 'lt:' + t.lt;
  if (item && item.in_msg && item.in_msg.hash) return asHex(item.in_msg.hash);
  return '';
}

function itemDestination(item) {
  if (item && item.in_msg && item.in_msg.destination) return item.in_msg.destination;
  if (item && item.account) return item.account;
  if (item && item.address && item.address.account_address) return item.address.account_address;
  return '';
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


// Canonical form of a TON address: the same account written as a friendly
// (UQ…/EQ…) or raw (0:…) string collapses to one key. '' when unparseable.
function normalizeAddress(a) {
  const s = String(a || '').trim();
  if (!s) return '';
  if (TonAddress) {
    try {
      return TonAddress.parse(s).toRawString().toLowerCase();
    } catch (e) { /* fall through to the plain string form */ }
  }
  return s.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Reading a signed transaction (TON Connect "pay with wallet" top-up)
 * ------------------------------------------------------------------ */

// Depth-first walk over the cells reachable from `cell`, collecting every
// internal message they carry. Wallet v4/v5 and high-load wallets all keep the
// outgoing transfers somewhere under the signed body, so a bounded walk finds
// them without needing to know which wallet contract signed.
function collectRelaxedMessages(cell, out, depth, seen) {
  if (!cell || depth > 6 || out.length >= 8 || typeof cell.beginParse !== 'function') return;
  let id = '';
  try { id = cell.hash().toString('hex'); } catch (e) { return; }
  if (seen.has(id)) return;
  seen.add(id);
  try {
    const relaxed = TonCore.loadMessageRelaxed(cell.beginParse());
    const info = relaxed && relaxed.info;
    if (info && info.type === 'internal' && info.dest) {
      const coins = info.value && info.value.coins;
      const nano = Number(coins == null ? 0 : coins);
      if (Number.isFinite(nano)) out.push({ dest: String(info.dest.toString()), valueNanoTon: nano });
    }
  } catch (e) { /* this cell is not a message — keep walking */ }
  const refs = cell.refs || [];
  for (const ref of refs) collectRelaxedMessages(ref, out, depth + 1, seen);
}

/**
 * Read what a signed transaction BOC actually pays.
 *
 * @param {string} boc  base64 BOC as returned by TON Connect sendTransaction
 * @returns {{ok:boolean, txHash?:string, payer?:string, transfers?:Array<{dest:string,valueNanoTon:number}>, reason?:string}}
 */
function parseSignedBoc(boc) {
  if (!TonCore || !TonCore.Cell || typeof TonCore.loadMessage !== 'function') {
    return { ok: false, reason: 'ton parser unavailable' };
  }
  if (typeof boc !== 'string' || boc.length < 32 || boc.length > 40000) {
    return { ok: false, reason: 'invalid transaction payload' };
  }
  let root = null;
  try {
    root = TonCore.Cell.fromBoc(Buffer.from(boc, 'base64'))[0];
  } catch (e) {
    return { ok: false, reason: 'invalid transaction payload' };
  }
  if (!root) return { ok: false, reason: 'invalid transaction payload' };

  let txHash = '';
  try { txHash = root.hash().toString('hex'); } catch (e) { /* leave empty */ }

  let payer = '';
  const transfers = [];
  try {
    const msg = TonCore.loadMessage(root.beginParse());
    const info = msg && msg.info;
    if (info && info.type === 'external-in' && info.dest) payer = String(info.dest.toString());
    const body = msg && msg.body; // Cell when the body was stored as a ref
    if (body && typeof body.beginParse === 'function') {
      collectRelaxedMessages(body, transfers, 0, new Set());
    }
  } catch (e) { /* hash-only fallback still applies */ }

  return { ok: !!txHash, txHash, payer, transfers, reason: txHash ? undefined : 'unreadable transaction' };
}

/* ------------------------------------------------------------------ *
 * On-chain lookup
 * ------------------------------------------------------------------ */

const TONCENTER_DEFAULT_URL = 'https://toncenter.com/api/v2';
const TONAPI_DEFAULT_URL = 'https://tonapi.io/v2';

/**
 * Provider-independent identity of one inbound transfer.
 *
 * Two indexers describe the SAME payment with different transaction/event ids,
 * so "has this transfer already been credited?" must key on the transfer
 * itself — who paid, how much and when — not on the id a particular indexer
 * handed out. Without this a payment credited through one provider could be
 * credited a second time through the fallback provider.
 *
 * @param {{source?:string,valueNanoTon?:number,utime?:number,txId?:string}} item
 * @param {string} [claimedHash] the hash the player submitted (hash matches)
 */
function transferIdentity(item, claimedHash) {
  const src = normalizeAddress(item && item.source);
  const value = Number((item && item.valueNanoTon) || 0);
  const utime = Number((item && item.utime) || 0);
  const hx = asHex(claimedHash || '');
  // A known sender + amount + block time IS the transfer, on every indexer.
  if (src && utime > 0) return 'sv:' + src + ':' + value + ':' + utime;
  // Without a block time the hash the player submitted is the stable key (it
  // comes from the client, so both indexers produce the same identity).
  if (hx) return 'hx:' + hx;
  if (src) return 'sv:' + src + ':' + value + ':0';
  return 'tx:' + String((item && item.txId) || '').toLowerCase();
}

// toncenter v2 "getTransactions" rows → the neutral shape used for matching.
function normalizeToncenterItem(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    txId: itemTxId(item),
    hashes: itemHashes(item),
    source: itemSource(item),
    destination: itemDestination(item),
    valueNanoTon: itemValueNanoTon(item),
    utime: itemUtime(item),
  };
}

function normalizeTxId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return asHex(s) || s.toLowerCase();
}

// tonapi v2 account events → the same neutral shape. tonapi is used as the
// fallback indexer: it has its own rate limits, so a throttled or unreachable
// toncenter (the default, keyless endpoint) cannot strand a real payment.
function normalizeTonapiEvent(ev) {
  const out = [];
  if (!ev || typeof ev !== 'object') return out;
  const utime = Number(ev.timestamp) > 0 ? Number(ev.timestamp) : 0;
  const eventId = String(ev.event_id || '');
  const actions = Array.isArray(ev.actions) ? ev.actions : [];
  for (const act of actions) {
    const tr = act && act.TonTransfer;
    if (!tr) continue; // jetton transfers, swaps, contract executions…
    const digits = String(tr.amount == null ? '' : tr.amount).replace(/[^0-9]/g, '');
    const amount = Math.abs(Number(digits));
    const sender = (tr.sender && (tr.sender.address || tr.sender)) ||
      (ev.sender && (ev.sender.address || ev.sender)) || '';
    const recipient = (tr.recipient && (tr.recipient.address || tr.recipient)) ||
      (ev.recipient && (ev.recipient.address || ev.recipient)) || '';
    const actionId = String(act.action_id || '');
    out.push({
      txId: normalizeTxId(actionId || eventId),
      hashes: [eventId, actionId].filter(Boolean),
      source: String(sender),
      destination: String(recipient),
      valueNanoTon: Number.isFinite(amount) ? amount : 0,
      utime,
    });
  }
  return out;
}

// Ledger providers, in the order they are tried. `TON_RPC_URL` picks the
// primary (toncenter by default); tonapi is always available as a fallback and
// can be pointed elsewhere with TONAPI_URL / keyed with TONAPI_KEY.
function buildLedgerProviders(o) {
  const fetchImpl = o.fetchImpl;
  const providers = [];

  const rpcUrl = (String(o.rpcUrl || '').trim().replace(/\/+$/, '')) || TONCENTER_DEFAULT_URL;
  providers.push({
    name: 'toncenter',
    async page(address, limit, cursor) {
      let url = `${rpcUrl}/getTransactions?address=${encodeURIComponent(address)}&limit=${limit}`;
      if (cursor) url += '&to_lt=' + encodeURIComponent(cursor);
      const headers = {};
      if (o.apiKey) headers['X-API-Key'] = o.apiKey;
      let resp;
      try {
        resp = await fetchImpl(url, { headers, method: 'GET' });
      } catch (err) {
        return { ok: false, error: (err && err.message) || 'network error' };
      }
      if (!resp || !resp.ok) return { ok: false, http: (resp && resp.status) || 0 };
      let body;
      try { body = await resp.json(); } catch (e) { return { ok: false, error: 'unreadable response' }; }
      const list = body && body.ok ? (body.result || []) : (body && body.result);
      if (!Array.isArray(list)) return { ok: false, error: 'unexpected response shape' };
      const items = list.map(normalizeToncenterItem).filter(Boolean);
      const last = list[list.length - 1];
      const nextCursor = last && last.transaction_id && last.transaction_id.lt
        ? String(last.transaction_id.lt)
        : '';
      return { ok: true, items, nextCursor };
    },
  });

  const tonapiUrl = (String(o.tonapiUrl || process.env.TONAPI_URL || '').trim().replace(/\/+$/, '')) || TONAPI_DEFAULT_URL;
  const tonapiKey = String(o.tonapiKey || process.env.TONAPI_KEY || '').trim();
  providers.push({
    name: 'tonapi',
    async page(address, limit) {
      const url = `${tonapiUrl}/blockchain/accounts/${encodeURIComponent(address)}/events?limit=${limit}`;
      const headers = { accept: 'application/json' };
      if (tonapiKey) headers.Authorization = 'Bearer ' + tonapiKey;
      let resp;
      try {
        resp = await fetchImpl(url, { headers, method: 'GET' });
      } catch (err) {
        return { ok: false, error: (err && err.message) || 'network error' };
      }
      if (!resp || !resp.ok) return { ok: false, http: (resp && resp.status) || 0 };
      let body;
      try { body = await resp.json(); } catch (e) { return { ok: false, error: 'unreadable response' }; }
      const events = body && Array.isArray(body.events) ? body.events : [];
      const items = [];
      for (const ev of events) items.push(...normalizeTonapiEvent(ev));
      // tonapi pages with an opaque cursor; one page of the newest events is
      // enough for a deposit that is being confirmed right now.
      return { ok: true, items, nextCursor: '' };
    },
  });

  return providers;
}

/**
 * Walk the deposit address's recent history, newest first, handing every
 * ledger row to `visit`. Providers are tried in order until one answers with
 * data, so a rate-limited or unreachable indexer cannot strand a payment.
 *
 * @param {object} o  { depositAddress, rpcUrl, apiKey, tonapiUrl, tonapiKey,
 *                      limit, maxPages, fetchImpl }
 * @param {(item:object, info:{provider:string,page:number}) => (boolean|Promise<boolean>)} visit
 *        return true to stop the whole scan early
 * @returns {Promise<{ok:boolean, provider?:string, scanned:number, failures:Array, stopped:boolean, reason?:string}>}
 */
async function scanDepositLedger(o, visit) {
  o = o || {};
  const address = String(o.depositAddress || '').trim();
  if (!address) return { ok: false, scanned: 0, failures: [], stopped: false, reason: 'no deposit address' };
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return { ok: false, scanned: 0, failures: [], stopped: false, reason: 'no network transport available', error: 'ENOTRANSPORT' };
  }
  const limit = Math.max(5, Math.min(100, Number(o.limit) || 30));
  const maxPages = Math.max(1, Math.min(10, Number(o.maxPages) || 5));
  const failures = [];
  let scanned = 0;

  for (const provider of buildLedgerProviders(Object.assign({}, o, { fetchImpl }))) {
    let cursor = null;
    let answered = false;
    let seenHere = 0;
    for (let page = 0; page < maxPages; page++) {
      const res = await provider.page(address, limit, cursor);
      if (!res || !res.ok) {
        failures.push({
          provider: provider.name,
          http: (res && res.http) || 0,
          error: (res && (res.error || res.reason)) || 'lookup failed',
        });
        break;
      }
      answered = true;
      const items = res.items || [];
      seenHere += items.length;
      for (const item of items) {
        scanned++;
        const stop = await visit(item, { provider: provider.name, page });
        if (stop) return { ok: true, provider: provider.name, scanned, failures, stopped: true };
      }
      if (!items.length) break;
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    // A provider that answered with rows is authoritative for this pass; an
    // empty/unavailable one hands over to the next indexer.
    if (answered && seenHere > 0) return { ok: true, provider: provider.name, scanned, failures, stopped: false };
    if (answered) failures.push({ provider: provider.name, http: 0, error: 'empty history' });
  }

  const first = failures[0] || {};
  return {
    ok: false,
    scanned,
    failures,
    stopped: false,
    reason: failures.length
      ? 'indexer lookup failed (' + failures.map((f) => f.provider + ': ' + (f.error || f.http)).join('; ') + ')'
      : 'no indexer available',
    http: first.http || 0,
  };
}

// The default tolerance for matching the SIGNED amount against the amount that
// arrived. Wallets normally forward it untouched; the slack only covers
// indexers that round or report a post-fee value.
const DEFAULT_VALUE_TOLERANCE = 0.02;

/**
 * Look for the player's transfer among the deposit address's recent history.
 *
 * @param {object} o
 * @param {string} o.txHash          claimed message/transaction hash
 * @param {string} o.depositAddress  the project's deposit address
 * @param {string} [o.expectedSource]      wallet that signed the payment
 * @param {number} [o.expectedValueNanoTon] amount inside the signed payment
 * @param {number} [o.notBeforeSec]  ignore transfers older than this (unix s)
 * @param {number} [o.valueTolerance] relative slack on expectedValueNanoTon
 * @param {string} [o.rpcUrl]        default https://toncenter.com/api/v2
 * @param {string} [o.apiKey]
 * @param {string} [o.tonapiUrl]     fallback indexer, default https://tonapi.io/v2
 * @param {string} [o.tonapiKey]
 * @param {number} [o.limit]         transactions per page
 * @param {number} [o.maxPages]      how far back to walk
 * @param {Function} [o.fetchImpl]   injected fetch (tests) — defaults to global.fetch
 */
async function verifyDepositClaim(o) {
  o = o || {};
  const txHash = String(o.txHash || '').trim();
  const depositAddress = String(o.depositAddress || '').trim();
  const expectedSource = String(o.expectedSource || '').trim();
  const expectedValue = Number(o.expectedValueNanoTon) || 0;
  const tolerance = Math.min(0.5, Math.max(0, Number(o.valueTolerance) >= 0
    ? Number(o.valueTolerance)
    : DEFAULT_VALUE_TOLERANCE));
  // Allow a little slack for wallet/indexer clock skew, never more.
  const notBefore = Math.floor(Number(o.notBeforeSec) || 0) - 120;

  // A "transfer" match needs BOTH the signer and the exact signed amount: the
  // amount alone is guessable (two players paying $1 in the same minute would
  // collide), the signer alone is not proof of value.
  const canMatchTransfer = !!(expectedSource && expectedValue > 0);

  if ((!txHash || txHash.length < 8) && !canMatchTransfer) {
    return { ok: false, reason: 'on-chain verification requires a tx hash and deposit address' };
  }
  if (!depositAddress) {
    return { ok: false, reason: 'on-chain verification requires a tx hash and deposit address' };
  }

  let best = null;               // matched transfer
  let sameAddressAny = false;    // some tx reached our address at all
  let foundAnyHash = false;

  const scan = await scanDepositLedger(o, (item, info) => {
    const toDeposit = addressesEqual(item.destination, depositAddress);
    const hashHit = !!txHash && (item.hashes || []).some((h) => isHashEqual(h, txHash));
    if (hashHit) foundAnyHash = true;

    if (toDeposit && hashHit) {
      best = {
        matchedBy: 'hash',
        valueNanoTon: item.valueNanoTon,
        source: item.source,
        utime: item.utime,
        txId: item.txId,
        identity: transferIdentity(item, txHash),
        provider: info.provider,
        toDeposit: true,
      };
      return true;
    }

    if (toDeposit) {
      sameAddressAny = true;
      if (canMatchTransfer) {
        const source = item.source;
        const value = item.valueNanoTon;
        const utime = item.utime;
        const sourceOk = !!source && addressesEqual(source, expectedSource);
        // Wallets forward the signed amount untouched; the slack only covers
        // rounding in the indexer's reported value.
        const valueOk = Math.abs(value - expectedValue) <= Math.max(expectedValue * tolerance, 1000);
        const timeOk = !notBefore || utime === 0 || utime >= notBefore;
        if (sourceOk && valueOk && timeOk) {
          best = {
            matchedBy: 'transfer', valueNanoTon: value, source, utime,
            txId: item.txId, identity: transferIdentity(item, txHash),
            provider: info.provider, toDeposit: true,
          };
          return true;
        }
      }
    }
    return false;
  });

  if (best) {
    return {
      ok: true,
      found: true,
      matchedBy: best.matchedBy,
      valueNanoTon: best.valueNanoTon,
      source: best.source,
      utime: best.utime,
      txId: best.txId || '',
      identity: best.identity || '',
      provider: best.provider || '',
    };
  }
  if (!scan.ok && !sameAddressAny && !foundAnyHash) {
    return { ok: false, found: false, reason: scan.reason || 'on-chain lookup failed', http: scan.http || 0, failures: scan.failures };
  }
  const reason = foundAnyHash && !sameAddressAny
    ? 'hash exists but was NOT paid to the deposit address'
    : 'no inbound transfer from that wallet to the deposit address found yet';
  return { ok: false, found: false, reason, sameAddressAny, foundAnyHash, scanned: scan.scanned, failures: scan.failures };
}

module.exports = {
  verifyDepositClaim,
  scanDepositLedger,
  transferIdentity,
  parseSignedBoc,
  addressesEqual,
  normalizeAddress,
  _t: {
    asHex, isHashEqual, itemHashes, itemValueNanoTon, itemSource, itemUtime,
    itemTxId, itemDestination, addressesEqual, collectRelaxedMessages,
    normalizeToncenterItem, normalizeTonapiEvent, buildLedgerProviders,
  },
};

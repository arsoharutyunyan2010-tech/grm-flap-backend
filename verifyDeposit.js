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
 * Config (all optional, sensible defaults):
 *   TON_RPC_URL=https://toncenter.com/api/v2   indexer to query
 *   TON_API_KEY=...                            only if the endpoint needs one
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

// Text comment carried by the inbound message (toncenter v2 exposes it either
// as a decoded `message` string or as msg_data.text in base64). Used to match
// a payment to the top-up intent whose memo was placed in the transfer.
function itemMemo(item) {
  const m = item && item.in_msg;
  if (!m) return '';
  if (typeof m.message === 'string' && m.message.trim()) return m.message.trim();
  const d = m.msg_data;
  if (d && typeof d.text === 'string' && d.text) {
    try {
      const buf = Buffer.from(d.text, 'base64');
      const txt = buf.toString('utf8').trim();
      if (txt) return txt;
    } catch (e) { /* not base64 */ }
    return String(d.text).trim();
  }
  if (typeof m.comment === 'string' && m.comment.trim()) return m.comment.trim();
  return '';
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
 * @param {number} [o.limit]         transactions per page
 * @param {number} [o.maxPages]      how far back to walk
 * @param {Function} [o.fetchImpl]   injected fetch (tests) — defaults to global.fetch
 */
async function verifyDepositClaim(o) {
  o = o || {};
  const txHash = String(o.txHash || '').trim();
  const depositAddress = String(o.depositAddress || '').trim();
  const limit = Math.max(5, Math.min(100, Number(o.limit) || 30));
  const maxPages = Math.max(1, Math.min(10, Number(o.maxPages) || 5));
  const expectedSource = String(o.expectedSource || '').trim();
  const expectedValue = Number(o.expectedValueNanoTon) || 0;
  // Unguessable per-request memo written into the transfer comment. When the
  // ledger row carries it, that alone proves which top-up the money is for —
  // even if the player paid from a different wallet than the one connected.
  const expectedMemo = String(o.expectedMemo || '').trim();
  const tolerance = Math.min(0.5, Math.max(0, Number(o.valueTolerance) >= 0
    ? Number(o.valueTolerance)
    : DEFAULT_VALUE_TOLERANCE));
  // Allow a little slack for wallet/indexer clock skew, never more.
  const notBefore = Math.floor(Number(o.notBeforeSec) || 0) - 120;

  // A "transfer" match needs BOTH the signer and the exact signed amount: the
  // amount alone is guessable (two players paying $1 in the same minute would
  // collide), the signer alone is not proof of value.
  const canMatchTransfer = !!(expectedSource && expectedValue > 0);

  if ((!txHash || txHash.length < 8) && !canMatchTransfer && !expectedMemo) {
    return { ok: false, reason: 'on-chain verification requires a tx hash and deposit address' };
  }
  if (!depositAddress) {
    return { ok: false, reason: 'on-chain verification requires a tx hash and deposit address' };
  }
  const rpcUrl = (String(o.rpcUrl || '').trim().replace(/\/+$/, '')) || 'https://toncenter.com/api/v2';
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return { ok: false, reason: 'no network transport available', error: 'ENOTRANSPORT' };
  }

  let nextLt = null;
  let scanned = 0;
  let best = null;               // matched transfer
  let sameAddressAny = false;    // some tx reached our address at all
  let foundAnyHash = false;

  // Scan pages of the address's history (newest → oldest) until we find the
  // transfer or run out of window.
  for (let page = 0; page < maxPages; page++) {
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
      const toAddress = itemDestination(item);
      const toDeposit = addressesEqual(toAddress, depositAddress);
      const hashes = itemHashes(item);
      const hashHit = !!txHash && hashes.some((h) => isHashEqual(h, txHash));
      if (hashHit) foundAnyHash = true;

      if (toDeposit && hashHit) {
        best = {
          matchedBy: 'hash',
          valueNanoTon: itemValueNanoTon(item),
          source: itemSource(item),
          utime: itemUtime(item),
          txId: itemTxId(item),
          toDeposit: true,
        };
        break;
      }

      if (toDeposit) {
        sameAddressAny = true;
        if (expectedMemo && itemMemo(item) === expectedMemo) {
          const utime = itemUtime(item);
          const timeOk = !notBefore || utime === 0 || utime >= notBefore;
          if (timeOk) {
            best = {
              matchedBy: 'memo', valueNanoTon: itemValueNanoTon(item), source: itemSource(item), utime,
              txId: itemTxId(item), toDeposit: true,
            };
            break;
          }
        }
        if (canMatchTransfer) {
          const source = itemSource(item);
          const value = itemValueNanoTon(item);
          const utime = itemUtime(item);
          const sourceOk = !!source && addressesEqual(source, expectedSource);
          // Wallets forward the signed amount untouched; the slack only covers
          // rounding in the indexer's reported value.
          const valueOk = Math.abs(value - expectedValue) <= Math.max(expectedValue * tolerance, 1000);
          const timeOk = !notBefore || utime === 0 || utime >= notBefore;
          if (sourceOk && valueOk && timeOk) {
            best = {
              matchedBy: 'transfer', valueNanoTon: value, source, utime,
              txId: itemTxId(item), toDeposit: true,
            };
            break;
          }
        }
      }
    }
    if (best) break;
    // Page forward using the oldest transaction id on this page (toncenter
    // paginates newest→oldest via to_lt of the last item).
    const last = list[list.length - 1];
    nextLt = last && last.transaction_id && last.transaction_id.lt;
    if (!nextLt) break;
  }

  if (best) {
    return {
      ok: true,
      found: true,
      matchedBy: best.matchedBy,
      valueNanoTon: best.valueNanoTon,
      source: best.source,
      utime: best.utime,
      txId: best.txId || '',
    };
  }
  const reason = foundAnyHash && !sameAddressAny
    ? 'hash exists but was NOT paid to the deposit address'
    : 'no inbound transfer from that wallet to the deposit address found yet';
  return { ok: false, found: false, reason, sameAddressAny, foundAnyHash, scanned };
}

/**
 * Fetch the most recent inbound transfers of the deposit address in one call,
 * normalised to { txId, source, valueNanoTon, memo, utime }. Used by the
 * periodic reconciliation sweep to match payments that never reported back
 * to the mini app (player paid inside the wallet and did not return).
 */
async function listRecentInbound(o) {
  o = o || {};
  const depositAddress = String(o.depositAddress || '').trim();
  if (!depositAddress) return { ok: false, reason: 'no deposit address', items: [] };
  const limit = Math.max(5, Math.min(100, Number(o.limit) || 50));
  const rpcUrl = (String(o.rpcUrl || '').trim().replace(/\/+$/, '')) || 'https://toncenter.com/api/v2';
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: 'no network transport available', items: [] };
  const headers = {};
  if (o.apiKey) headers['X-API-Key'] = o.apiKey;
  const url = `${rpcUrl}/getTransactions?address=${encodeURIComponent(depositAddress)}&limit=${limit}`;
  let resp;
  try {
    resp = await fetchImpl(url, { headers, method: 'GET' });
  } catch (e) {
    return { ok: false, reason: 'on-chain lookup failed', items: [] };
  }
  if (!resp || !resp.ok) return { ok: false, reason: 'on-chain lookup failed', http: resp && resp.status, items: [] };
  const body = await resp.json();
  const list = body && body.ok ? (body.result || []) : (body && body.result);
  if (!Array.isArray(list)) return { ok: false, reason: 'bad indexer response', items: [] };
  const items = [];
  for (const item of list) {
    if (!addressesEqual(itemDestination(item), depositAddress)) continue;
    const value = itemValueNanoTon(item);
    if (!(value > 0)) continue;
    items.push({
      txId: itemTxId(item),
      source: itemSource(item),
      valueNanoTon: value,
      memo: itemMemo(item),
      utime: itemUtime(item),
      hashes: itemHashes(item),
    });
  }
  return { ok: true, items };
}

/**
 * Build the base64 BOC of a plain text-comment payload (op=0 + UTF-8 text) so
 * the mini app can attach the top-up memo to the TON Connect transfer.
 */
function buildCommentPayload(text) {
  if (!TonCore || typeof TonCore.beginCell !== 'function') return '';
  try {
    return TonCore.beginCell().storeUint(0, 32).storeStringTail(String(text || '')).endCell().toBoc().toString('base64');
  } catch (e) {
    return '';
  }
}

module.exports = {
  verifyDepositClaim,
  listRecentInbound,
  buildCommentPayload,
  parseSignedBoc,
  addressesEqual,
  _t: {
    asHex, isHashEqual, itemHashes, itemValueNanoTon, itemSource, itemUtime, itemMemo,
    itemTxId, itemDestination, addressesEqual, collectRelaxedMessages,
  },
};

import crypto from "crypto";
import { okx } from "./config.js";

/*
x402 — HTTP-native payments (the OKX AI / Coinbase standard).

SELLER SIDE (Tier 1, XMAIL's three paid services) now runs on OKX's
official x402 SDK (@okxweb3/x402-express + x402-core + x402-evm) — see
src/okx/services.js. Payments are verified and settled through OKX's
Broker/Facilitator infrastructure, not a custom verifier, so real buyers
on OKX.AI's A2MCP marketplace can actually pay XMAIL. The homemade
voucher signer + raw-RPC chain verifier that used to live here (and in
the now-removed src/okx/chain.js) have been replaced.

BUYER SIDE (Tier 2, XMAIL hiring another agent, e.g. the scam-check) is
intentionally left on the mock/testnet demo path below — signVoucher,
payAndCall, and settleOnchain are unrelated to the Tier 1 upgrade and are
still used by scamcheck.js.
*/

/* ---------------- mock-mode voucher helpers (dev/demo only) ---------------- */
function signVoucher(payload) {
  const key = okx.walletKey || "dev-mock-key";
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", key).update(body).digest("hex");
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString("base64");
}
function verifyVoucher(proofB64, expect) {
  try {
    const proof = JSON.parse(Buffer.from(proofB64, "base64").toString());
    const key = okx.walletKey || "dev-mock-key";
    const { sig, ...payload } = proof;
    const good = crypto.createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
    if (sig !== good) return { ok: false, reason: "bad signature" };
    if (payload.amount < expect.amount) return { ok: false, reason: "underpaid" };
    if (payload.token !== expect.token) return { ok: false, reason: "wrong token" };
    if (payload.nonce !== expect.nonce) return { ok: false, reason: "nonce mismatch" };
    return { ok: true, payer: payload.payer, txRef: payload.txRef || "mock" };
  } catch {
    return { ok: false, reason: "malformed proof" };
  }
}

/* =====================================================================
   SERVER SIDE (bundled mock ASP only — src/okx/mockAsp.js) — this is NOT
   what XMAIL's own Tier 1 services use anymore (those run on the official
   SDK in services.js). This stays so the bundled scam-check counterparty
   can keep speaking the simple mock voucher protocol to payAndCall below.
   ===================================================================== */

// pending challenges: nonce -> {amount, token, service, createdAt}  (mock mode only)
const challenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [n, c] of challenges) if (now - c.createdAt > 5 * 60 * 1000) challenges.delete(n);
}, 60 * 1000);

/**
 * Express middleware factory (mock-mode only): require payment of `amount`
 * USDT before the handler runs. Attaches req.payment = { payer, txRef, amount }
 * on success. Used only by the bundled mock ASP, not XMAIL's real services.
 */
export function requirePayment(amount, serviceName = "xmail-service") {
  return async (req, res, next) => {
    const proof = req.headers["x-payment"];

    if (!proof) {
      const nonce = crypto.randomBytes(12).toString("hex");
      challenges.set(nonce, { amount, token: okx.token, service: serviceName, createdAt: Date.now() });
      res.status(402).json({
        error: "Payment Required",
        x402: {
          amount,
          token: okx.token,
          chainId: okx.chainId,
          payTo: okx.walletAddress || "0xXMAIL_WALLET_NOT_SET",
          nonce,
          proofFormat: "base64 JSON { amount, token, nonce, payer, sig } (mock voucher — dev only)",
          note: "Pay then retry with header X-Payment: <proof>",
        },
      });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(proof, "base64").toString());
    } catch {
      return res.status(400).json({ error: "Malformed X-Payment proof" });
    }
    const challenge = challenges.get(payload.nonce);
    if (!challenge) return res.status(402).json({ error: "Unknown or expired payment nonce — request a fresh 402." });
    const v = verifyVoucher(proof, { amount: challenge.amount, token: challenge.token, nonce: payload.nonce });
    if (!v.ok) return res.status(402).json({ error: "Payment invalid: " + v.reason });
    challenges.delete(payload.nonce); // one-time use
    req.payment = { payer: v.payer, txRef: v.txRef, amount: challenge.amount };
    next();
  };
}

/* =====================================================================
   CLIENT SIDE (Tier 2) — XMAIL pays to hire another agent
   ===================================================================== */

/**
 * Call an x402-protected endpoint, paying automatically if challenged.
 * Enforces maxPrice. Returns the JSON result, or throws.
 * `spend(amount)` is a callback to record/enforce the daily cap; it should
 * throw if the cap would be exceeded.
 */
export async function payAndCall(endpoint, payload, { maxPrice, spend }) {
  const withTimeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };

  // first attempt (unpaid)
  let res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: withTimeout(8000),
  });

  if (res.status === 402) {
    const body = await res.json();
    const q = body.x402 || {};
    if (q.amount > maxPrice) throw new Error(`Quote ${q.amount} ${q.token} exceeds max ${maxPrice}`);

    // enforce daily cap (throws if exceeded) — before paying
    spend(q.amount);

    // "pay": mock mode -> signed voucher; onchain -> settle then reference tx
    const proof = signVoucher({
      amount: q.amount,
      token: q.token,
      nonce: q.nonce,
      payer: okx.walletAddress || "0xXMAIL_DEV",
      txRef: okx.network === "mock" ? "mock" : await settleOnchain(q),
    });

    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body: JSON.stringify(payload),
      signal: withTimeout(8000),
    });
  }

  if (!res.ok) throw new Error(`Hired agent returned ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

/**
 * Real onchain settlement placeholder. On testnet/mainnet this signs and
 * broadcasts a USDT transfer to q.payTo for q.amount using okx.walletKey,
 * and returns the tx hash. Kept isolated so the rest of the code is
 * network-agnostic. Wired to the OnchainOS payment SDK at go-live.
 */
async function settleOnchain(q) {
  // Intentionally not broadcasting from this environment.
  // At go-live: use OnchainOS/Agent Payments SDK to send q.amount USDT to q.payTo.
  throw new Error("Onchain settlement runs via OnchainOS at go-live; use OKX_NETWORK=mock for local demo.");
}

import { config as base } from "../config.js";

/*
XMAIL on OKX.AI — configuration.

Tier 1 (SELLER, live): XMAIL exposes services other agents pay to call.
Tier 2 (BUYER, demo/testnet): XMAIL hires a scam-check agent via x402.

Everything is driven by env vars so the same code runs against a local
mock counterparty (dev), testnet, or mainnet with no edits.
*/
export const okx = {
  // XMAIL's Agentic Wallet — created by you via OnchainOS, address+key pasted into env.
  // The private key signs outbound payments (Tier 2) and proves identity.
  walletAddress: process.env.OKX_WALLET_ADDRESS || "",
  walletKey: process.env.OKX_WALLET_KEY || "", // keep secret; never commit

  // network: "mock" (local, no chain), "testnet", or "mainnet" — Tier 2 (buyer) only
  network: process.env.OKX_NETWORK || "mock",

  // Official OKX x402 Facilitator credentials (Tier 1 seller) — from the
  // OKX Developer Portal. Required for real ASP registration on OKX.AI.
  apiKey: process.env.OKX_API_KEY || "",
  secretKey: process.env.OKX_SECRET_KEY || "",
  passphrase: process.env.OKX_PASSPHRASE || "",
  // CAIP-2 network id for Tier 1 payments (verified via OKX's official
  // Facilitator, not a custom verifier): eip155:1952 = X Layer testnet,
  // eip155:196 = X Layer mainnet.
  networkId: process.env.OKX_NETWORK_ID || "eip155:1952",

  // x402 settlement token + chain info
  token: process.env.OKX_TOKEN || "USDT",
  chainId: Number(process.env.OKX_CHAIN_ID || 196), // X Layer mainnet = 196

  // ---- Tier 1: prices XMAIL charges (in smallest USDT units is overkill for demo; use decimal) ----
  sell: {
    triage: Number(process.env.PRICE_TRIAGE || 0.005),
    draftReply: Number(process.env.PRICE_DRAFT || 0.02),
    fillTemplate: Number(process.env.PRICE_FILL || 0.02),
    report: Number(process.env.PRICE_REPORT || 0.05),
  },

  // ---- Tier 2: what XMAIL will pay to hire a scam-check agent ----
  scamCheck: {
    enabled: (process.env.SCAM_CHECK_ENABLED || "true").toLowerCase() !== "false",
    // endpoint of the scam-check ASP. Defaults to XMAIL's own bundled mock.
    endpoint: process.env.SCAM_CHECK_ENDPOINT || `${base.baseUrl}/mock-asp/scan`,
    maxPrice: Number(process.env.SCAM_CHECK_MAX_PRICE || 0.002), // won't pay more than this per call
    dailyCap: Number(process.env.SCAM_CHECK_DAILY_CAP || 1.0),   // hard USDT/day ceiling
  },

  isLive() {
    return !!(this.walletAddress && this.walletKey && this.network !== "mock");
  },
};

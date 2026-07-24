import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { okx } from "./config.js";
import { analyzeEmail, draftReply, fillTemplate, rangeReport } from "../ai.js";
import { detectSpamSignals } from "./spam.js";
import { hashToken } from "../crypto.js";
import * as db from "../db.js";

/*
Tier 1 — XMAIL as a SELLER on OKX.AI.

Three services other agents pay to call, each x402-priced. These wrap
XMAIL's existing intelligence so any agent on the marketplace can use
XMAIL's inbox brain as a paid micro-service.

Payment verification and settlement run through OKX's official x402
Facilitator (@okxweb3/x402-express + x402-core + x402-evm), not a
homemade verifier — required for XMAIL to work with real buyers once
registered as an A2MCP ASP on OKX.AI. Every successful call = onchain
income to XMAIL's Agentic Wallet.
*/

let earned = 0;
let calls = 0;
export function earnings() {
  return { earned: Number(earned.toFixed(6)), calls, token: okx.token };
}
function record(amount) {
  earned += amount;
  calls += 1;
}

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: okx.apiKey,
  secretKey: okx.secretKey,
  passphrase: okx.passphrase,
});

const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(okx.networkId, new ExactEvmScheme());

const ASP_PAID_ROUTES = ["/asp/triage", "/asp/draft_reply", "/asp/fill_template", "/asp/report"];

export function mountServices(app) {
  // These are agent-to-agent API endpoints, never a human-browsed page.
  // @okxweb3/x402-core's paymentMiddleware treats any request whose Accept
  // header contains "text/html" AND whose User-Agent contains "Mozilla" as
  // a browser, and serves an HTML paywall for it instead of a JSON 402 —
  // that branch never sets the PAYMENT-REQUIRED header. Marketplace review
  // crawlers (and many HTTP clients) send exactly that combination by
  // default, so without this normalization the 402 challenge is malformed
  // and gets rejected during ASP listing review. Force JSON handling so the
  // 402 always carries a valid PAYMENT-REQUIRED header.
  app.use(ASP_PAID_ROUTES, (req, res, next) => {
    req.headers.accept = "application/json";
    next();
  });

  app.use(
    paymentMiddleware(
      {
        "POST /asp/triage": {
          accepts: [{ scheme: "exact", network: okx.networkId, payTo: okx.walletAddress, price: `$${okx.sell.triage}` }],
          description: "XMAIL email triage report — summary, action, caller-defined category, priority, spam signals",
          mimeType: "application/json",
        },
        "POST /asp/draft_reply": {
          accepts: [{ scheme: "exact", network: okx.networkId, payTo: okx.walletAddress, price: `$${okx.sell.draftReply}` }],
          description: "XMAIL reply drafting",
          mimeType: "application/json",
        },
        "POST /asp/fill_template": {
          accepts: [{ scheme: "exact", network: okx.networkId, payTo: okx.walletAddress, price: `$${okx.sell.fillTemplate}` }],
          description: "XMAIL template fill",
          mimeType: "application/json",
        },
        "POST /asp/report": {
          accepts: [{ scheme: "exact", network: okx.networkId, payTo: okx.walletAddress, price: `$${okx.sell.report}` }],
          description: "XMAIL inbox report over a date range — requires an access token the mailbox owner issued to you",
          mimeType: "application/json",
        },
      },
      resourceServer
    )
  );

  // ---- xmail.triage : summary + action + caller-defined category + priority + spam report ----
  app.post("/asp/triage", async (req, res) => {
    const { from, fromAddr, subject, body, attachments, categories } = req.body || {};
    if (!subject && !body) return res.status(400).json({ error: "subject or body required" });
    const catList = Array.isArray(categories) ? categories.filter((c) => typeof c === "string" && c.trim()).slice(0, 20) : [];
    try {
      const email = { from: from || fromAddr || "", subject: subject || "", body: body || "", attachments: attachments || [] };
      const a = await analyzeEmail(email, catList);
      const spam = detectSpamSignals({ fromAddr: fromAddr || from || "", subject: email.subject, body: email.body });
      const priority = spam.flagged && spam.risk >= 0.7 ? "low" : a.action ? "high" : "normal";
      record(okx.sell.triage);
      res.json({
        service: "xmail.triage",
        price: okx.sell.triage,
        result: { ...a, priority, spam },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- xmail.draft_reply : draft a reply in a requested tone/format ----
  app.post("/asp/draft_reply", async (req, res) => {
    const { from, subject, body, instruction } = req.body || {};
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    try {
      const draft = await draftReply({ from: from || "", subject: subject || "", body: body || "" }, instruction);
      record(okx.sell.draftReply);
      res.json({ service: "xmail.draft_reply", price: okx.sell.draftReply, result: { draft } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- xmail.fill_template : fill a placeholder template from an email ----
  app.post("/asp/fill_template", async (req, res) => {
    const { from, subject, body, template } = req.body || {};
    if (!template) return res.status(400).json({ error: "template required" });
    try {
      const filled = await fillTemplate({ from: from || "", subject: subject || "", body: body || "" }, { content: template });
      record(okx.sell.fillTemplate);
      res.json({ service: "xmail.fill_template", price: okx.sell.fillTemplate, result: { filled } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- xmail.report : date-ranged inbox report, gated behind an access token the mailbox owner issued ----
  app.post("/asp/report", async (req, res) => {
    const { accessToken, days } = req.body || {};
    if (!accessToken || typeof accessToken !== "string") return res.status(400).json({ error: "accessToken required" });
    const rangeDays = Math.min(Math.max(Number(days) || 14, 1), 400);

    const grant = await db.aspGrantByHash(hashToken(accessToken));
    if (!grant || grant.revoked_at || (grant.expires_at && grant.expires_at < Date.now())) {
      return res.status(403).json({ error: "Invalid, expired, or revoked access token. Ask the mailbox owner to issue a new one." });
    }

    try {
      const since = Date.now() - rangeDays * 24 * 3600 * 1000;
      const emails = await db.emailsInRange(grant.user_id, since);
      db.touchAspGrant(grant.id).catch(() => {});

      const byCategory = {};
      const priorityCounts = { high: 0, normal: 0, low: 0 };
      const spamFlagged = [];
      for (const e of emails) {
        const cat = e.category || "Uncategorized";
        if (!byCategory[cat]) byCategory[cat] = { count: 0, emails: [] };
        byCategory[cat].count += 1;
        if (byCategory[cat].emails.length < 25) {
          byCategory[cat].emails.push({ id: e.id, from: e.from, subject: e.subject, receivedAt: e.receivedAt, summary: e.summary, priority: e.priority, action: e.action });
        }
        priorityCounts[e.priority in priorityCounts ? e.priority : "normal"] += 1;
        if (e.scamRisk >= 0.5) {
          let reasons = [];
          try { reasons = JSON.parse(e.scamReasons || "[]"); } catch { /* leave empty */ }
          spamFlagged.push({ id: e.id, from: e.from, subject: e.subject, risk: e.scamRisk, reasons });
        }
      }

      const overview = await rangeReport(emails.slice(0, 200), rangeDays);
      record(okx.sell.report);
      res.json({
        service: "xmail.report",
        price: okx.sell.report,
        result: { rangeDays, totalEmails: emails.length, overview, byCategory, priorityCounts, spamFlagged },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- public service manifest (what OKX.AI lists) ----
  app.get("/asp/manifest", (req, res) => {
    res.json({
      name: "XMAIL",
      tagline: "Never miss an email. Inbox triage reports, reply drafting and template filling as paid agent services.",
      wallet: okx.walletAddress || "(not set — create Agentic Wallet)",
      network: okx.networkId,
      token: okx.token,
      services: [
        { name: "xmail.triage", price: okx.sell.triage, endpoint: "/asp/triage",
          input: "{ from, subject, body, attachments[], categories[] (optional — your own category list; defaults to a single 'Other' bucket) }",
          output: "{ summary, action, highlights[], category, priority: high|normal|low, spam: { flagged, risk, reasons[] } }" },
        { name: "xmail.draft_reply", price: okx.sell.draftReply, endpoint: "/asp/draft_reply",
          input: "{ from, subject, body, instruction }", output: "{ draft }" },
        { name: "xmail.fill_template", price: okx.sell.fillTemplate, endpoint: "/asp/fill_template",
          input: "{ from, subject, body, template }", output: "{ filled }" },
        { name: "xmail.report", price: okx.sell.report, endpoint: "/asp/report",
          input: "{ accessToken, days (1-400, default 14) } — accessToken must be issued by the mailbox owner, not just paid for",
          output: "{ rangeDays, totalEmails, overview, byCategory, priorityCounts, spamFlagged }" },
      ],
    });
  });

  console.log(`XMAIL ASP services mounted: /asp/triage /asp/draft_reply /asp/fill_template /asp/report (OKX official x402 SDK, network ${okx.networkId}).`);
}

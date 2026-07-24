/*
Standard spam-behaviour heuristics for the /asp/triage report.

Deterministic and free (no paid agent hire, no LLM call) — kept separate
from src/okx/scamcheck.js's looksWorthChecking(), which pre-filters XMAIL's
own inbound mail before optionally paying a third-party scam-check agent
and has access to the end-user's known-senders list. A triage caller here
is a stranger's email submitted by another agent, with no such context, so
this only looks at signals present in the email itself.
*/

const URGENT = /(urgent|verify|suspended|password|wire transfer|gift card|bitcoin|crypto|prize|you.?ve won|claim now|unusual activity|act now|limited time|final notice)/i;
const SUSPICIOUS_TLD = /\.(xyz|top|click|loan|zip|mov|country|gq)$/;
const GENERIC_GREETING = /dear (customer|user|valued|sir\/?madam|member)/i;

export function detectSpamSignals({ fromAddr = "", subject = "", body = "" }) {
  const reasons = [];
  const text = `${subject} ${body}`;

  if (URGENT.test(text)) reasons.push("urgent/pressure language");
  if (/https?:\/\//.test(text)) reasons.push("contains an external link");

  const domain = (fromAddr.split("@")[1] || "").toLowerCase();
  if (SUSPICIOUS_TLD.test(domain)) reasons.push("sender domain uses a throwaway TLD");

  const letters = subject.replace(/[^A-Za-z]/g, "");
  const upper = subject.replace(/[^A-Z]/g, "");
  if (letters.length > 6 && upper.length / letters.length > 0.7) reasons.push("subject is mostly uppercase");

  if ((subject.match(/!/g) || []).length >= 2) reasons.push("excessive exclamation marks");
  if (GENERIC_GREETING.test(body)) reasons.push("generic mass-mail greeting");

  const risk = Math.min(1, reasons.length / 4);
  return { flagged: risk >= 0.5, risk: Number(risk.toFixed(2)), reasons };
}

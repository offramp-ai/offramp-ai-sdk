// Regex PII Sanitizer — runs on every prompt regardless of task category,
// before anything is shown as "eligible to leave the device." This is
// separate from task classification: a prompt can be an "other" task AND
// still contain PII worth flagging.

export interface PiiSpan {
  type: "ssn" | "email" | "credit_card" | "phone" | "ip_address";
  match: string;
}

const OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";

const PATTERNS: { type: PiiSpan["type"]; re: RegExp }[] = [
  { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { type: "credit_card", re: /\b(?:\d[ -]*?){13,16}\b/g },
  { type: "phone", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // IPv4 only for now — proper octet ranges (0-255) so it doesn't false-
  // positive on things like software version strings ("10.20.30.400").
  { type: "ip_address", re: new RegExp(`\\b${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}\\b`, "g") },
];

export function scanAndRedact(input: string): { redacted: string; spans: PiiSpan[] } {
  let redacted = input;
  const spans: PiiSpan[] = [];

  for (const { type, re } of PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      spans.push({ type, match });
      return `[REDACTED_${type.toUpperCase()}]`;
    });
  }

  return { redacted, spans };
}

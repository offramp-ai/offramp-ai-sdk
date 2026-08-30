// Validity checks — this is what makes "resolved locally" a defensible claim
// instead of just "matched a keyword pattern." Only categories with an
// objective, automatable check count toward the headline "resolved &
// verified" stat; summarization has no cheap objective check, so it's
// tracked separately and never rolled into that number.

// A real JSON key is a short field name ("Name", "SSN") — not a full
// instruction sentence. Without this, resolveJsonLocally can swallow the
// leading instruction clause as a "key" (e.g. "Convert this text into
// Markdown table headers and rows" as a key, with the actual data as its
// value) and still produce syntactically valid, non-empty JSON that would
// otherwise pass. Found via benchmarking against realistic single-line
// prompts, not a hypothetical — this closed real false-positives, not just
// a theoretical hole.
const MAX_PLAUSIBLE_KEY_WORDS = 5;
const MAX_PLAUSIBLE_KEY_CHARS = 40;

function looksLikeARealKey(key: string): boolean {
  return key.length <= MAX_PLAUSIBLE_KEY_CHARS && key.trim().split(/\s+/).length <= MAX_PLAUSIBLE_KEY_WORDS;
}

export function isValidJson(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0) return false;
    return Object.keys(parsed).every(looksLikeARealKey);
  } catch {
    return false;
  }
}

export function isCleanOfHtml(output: string): boolean {
  return !/<\/?[a-z][\s\S]*?>/i.test(output);
}

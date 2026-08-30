// Deterministic Edge Logic Gate.
//
// This is intentionally simple and inspectable — the whole pitch is "we can
// prove what gets resolved locally and why," so the routing logic should be
// readable in thirty seconds, not a black box.

import { hasParsableKeyValueData } from "./localResolvers";

// Single source of truth for valid categories — server/telemetry.ts and
// server/promptLog.ts import THIS rather than keeping their own copy of the
// list. They used to duplicate it, and it silently drifted out of sync the
// moment "translate" was added here but not there (every telemetry POST for
// a translate-category prompt 400'd until this got unified) — same failure
// shape as the classifier/resolver duplication fixed earlier, so worth
// actually removing the duplication this time instead of just patching the
// symptom again.
export const TASK_CATEGORIES = ["json", "html", "summarize", "translate", "other"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export interface Classification {
  category: TaskCategory;
  /** True if this category is one we can resolve without a model at all
   *  (pure string transforms — genuinely near-instant). */
  ruleBasedEligible: boolean;
  reason: string;
  /** Only set for "translate" — the BCP-47 code the resolver should ask
   *  Chrome's Translator API for (e.g. "es" for Spanish). */
  targetLanguageCode?: string;
}

const HTML_HINTS = /\b(strip|clean|remove).{0,20}\b(html|tags?)\b/i;
const HAS_HTML_TAGS = /<\/?[a-z][\s\S]*?>/i;

const SUMMARIZE_HINTS = /\b(summarize|summary|tl;?dr|shorten|condense)\b/i;

// Language names a visitor would plausibly type, mapped to the BCP-47 code
// Chrome's Translator API expects. Not exhaustive — add more as needed.
export const LANGUAGE_CODES: Record<string, string> = {
  spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt",
  dutch: "nl", russian: "ru", chinese: "zh", mandarin: "zh", japanese: "ja",
  korean: "ko", arabic: "ar", hindi: "hi", polish: "pl", swedish: "sv",
  norwegian: "no", danish: "da", finnish: "fi", greek: "el", turkish: "tr",
  vietnamese: "vi", thai: "th", indonesian: "id", hebrew: "he", english: "en",
};

const TRANSLATE_HINTS = new RegExp(
  `\\b(translate|switch|convert)\\b.{0,25}\\b(to|into|in)\\b\\s+(${Object.keys(LANGUAGE_CODES).join("|")})\\b`,
  "i",
);

export function classify(promptRaw: string): Classification {
  const prompt = promptRaw.trim();

  if (!prompt) {
    return { category: "other", ruleBasedEligible: false, reason: "empty input" };
  }

  // HTML checked before JSON deliberately: literal "<tag>" content (or an
  // explicit "strip/clean ... html" phrasing) is a much stronger, less
  // ambiguous signal than KEY_VALUE_LINES's "some sentence ending in a
  // colon" heuristic. Without this ordering, a prompt like "Strip the HTML
  // from this: <div>...</div>" gets swallowed by the JSON check purely
  // because it has a colon before the markup — checked and confirmed via
  // the benchmark script, not a hypothetical.
  if (HTML_HINTS.test(prompt) || HAS_HTML_TAGS.test(prompt)) {
    return {
      category: "html",
      ruleBasedEligible: true,
      reason: "looks like an HTML cleaning/stripping request",
    };
  }

  // Uses the exact same "does this have parsable key/value data" check the
  // resolver itself uses (see localResolvers.ts), rather than a separate,
  // looser "mentions JSON or ends in a colon" heuristic — a prompt only
  // claims json eligibility here if the resolver can genuinely find
  // something to extract, not just because it says the word "JSON".
  if (hasParsableKeyValueData(prompt)) {
    return {
      category: "json",
      ruleBasedEligible: true,
      reason: "looks like a structural JSON/key-value conversion request",
    };
  }

  const translateMatch = TRANSLATE_HINTS.exec(prompt);
  if (translateMatch) {
    return {
      category: "translate",
      // Needs Chrome's Translator API (a different, purpose-built model
      // family from the general Prompt API summarize uses below) — only
      // resolves locally where that API is available. See
      // localResolvers.ts's isTranslatorAvailable / resolveWithTranslator.
      ruleBasedEligible: false,
      reason: "looks like a translation request",
      targetLanguageCode: LANGUAGE_CODES[translateMatch[3].toLowerCase()],
    };
  }

  if (SUMMARIZE_HINTS.test(prompt) && prompt.length < 2000) {
    return {
      category: "summarize",
      // Summarization needs an actual model (local or cloud) — it's not a
      // pure string transform, so it is NOT rule-based-eligible. It only
      // resolves locally if an on-device model (window.ai) is available.
      ruleBasedEligible: false,
      reason: "short summarization request — needs a model, local or cloud",
    };
  }

  return {
    category: "other",
    ruleBasedEligible: false,
    reason: "no structural pattern matched — would route to cloud in production",
  };
}

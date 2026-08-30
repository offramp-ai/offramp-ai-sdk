// Local resolution paths.
//
// Two genuinely different mechanisms, and the demo is careful not to blur
// them, because the honesty of the latency number depends on it:
//
// 1. Rule-based (json/html): pure string transforms, no model involved.
//    This is the only path where a "12ms" style number is real.
// 2. On-device model (window.ai / Chrome Prompt API): actual local
//    inference. Real, but real inference latency — typically hundreds of
//    ms after the model is warm, not single-digit ms. We measure and show
//    the real number rather than reusing the rule-based figure.

export interface ResolutionResult {
  output: string;
  latencyMs: number;
  mode: "rule-based" | "on-device-model" | "on-device-translator";
}

// Any real browser AI API call is a black box we don't control — it can
// hang instead of rejecting (confirmed directly: a stub Translator.
// availability() in one test environment never resolved OR rejected,
// which without this would leave the submit button stuck on "Resolving…"
// forever with no way out). Every on-device model/translator call below
// goes through this, so a slow or stuck API degrades to "fall back to the
// cloud estimate" instead of freezing the UI.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Words that start an instruction clause, not a field name. Word count
// alone isn't enough to tell "Name" from an instruction — "Convert this to
// JSON" is a plain 4-word imperative sentence, the same length as a
// perfectly ordinary field name like "Estimated Repair Cost", and slipped
// through an earlier, count-only version of this pattern as a garbage key.
// What actually distinguishes them is that real field names are noun
// phrases and instructions lead with an imperative verb — so reject any
// candidate key whose first word is one of these.
const INSTRUCTION_VERBS =
  "convert|format|extract|strip|clean|summarize|rewrite|draft|write|redact|sanitize|classify|" +
  "determine|translate|list|create|generate|transform|parse|output|return|give|provide|show|" +
  "tell|please|remove|replace|analyze|calculate";

// Finds every place in a prompt that plausibly LOOKS like a real "key:"
// (short — at most 4 words, not starting with an instruction verb —
// sitting right after a natural boundary: line start, comma, semicolon, or
// another key's colon). Exported so the classifier can use the exact same
// definition of "this has parsable key/value data" that the resolver does,
// instead of maintaining a second, looser heuristic that can silently
// drift out of sync with what the resolver can actually handle — which is
// exactly what happened before this was split out (the classifier kept
// routing plain "rewrite this: ..." sentences into JSON just because they
// had one colon in them).
export const KEY_VALUE_PATTERN = new RegExp(
  `(?:^|[,;:\\n])\\s*(?!(?:${INSTRUCTION_VERBS})\\b)([\\w'./-]{1,25}(?:\\s[\\w'./-]{1,25}){0,3}):\\s*`,
  "gi",
);

export function hasParsableKeyValueData(prompt: string): boolean {
  return new RegExp(KEY_VALUE_PATTERN.source, KEY_VALUE_PATTERN.flags).test(prompt);
}

/** Best-effort structural JSON conversion from "key: value" pairs, however
 *  they're laid out: one per line, several inline separated by commas, or —
 *  the case that broke earlier versions of this function — a leading
 *  instruction clause immediately followed by the first real key with no
 *  comma between them ("Convert this to JSON: Name: Alex Rivera, Plan:
 *  Pro"). Rather than guessing where an instruction sentence ends, this
 *  takes each key's value as the text up to the next such key — anything
 *  before the first real key (the instruction clause itself) is simply
 *  never captured, instead of becoming a garbage key with the real data
 *  trapped inside its value. */
export function resolveJsonLocally(prompt: string): ResolutionResult {
  const start = performance.now();

  const matches = [...prompt.matchAll(new RegExp(KEY_VALUE_PATTERN.source, KEY_VALUE_PATTERN.flags))];

  const obj: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const key = m[1].trim();
    const valueStart = m.index + m[0].length;
    const valueEnd = i + 1 < matches.length ? matches[i + 1].index : prompt.length;
    const value = prompt.slice(valueStart, valueEnd).trim().replace(/[,;]\s*$/, "");
    if (key && value) obj[key] = value;
  }

  const output = JSON.stringify(obj, null, 2);
  const latencyMs = performance.now() - start;

  return { output, latencyMs, mode: "rule-based" };
}

/** Strips HTML tags with a real DOM parse (more reliable than a regex). */
export function resolveHtmlLocally(prompt: string): ResolutionResult {
  const start = performance.now();

  const doc = new DOMParser().parseFromString(prompt, "text/html");
  const output = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();

  const latencyMs = performance.now() - start;
  return { output, latencyMs, mode: "rule-based" };
}

// --- On-device model path (Chrome built-in AI / window.ai) -----------------

type PromptAPISession = { prompt: (input: string) => Promise<string>; destroy?: () => void };
type LanguageModelCreateOptions = { expectedOutputs?: { type: "text"; languages: string[] }[] };
type LanguageModelAPI = {
  create: (opts?: LanguageModelCreateOptions) => Promise<PromptAPISession>;
  availability?: (opts?: LanguageModelCreateOptions) => Promise<string>;
};

function getLanguageModelAPI(): LanguageModelAPI | undefined {
  const w = window as unknown as {
    LanguageModel?: LanguageModelAPI;
    ai?: { languageModel?: LanguageModelAPI };
  };
  return w.LanguageModel ?? w.ai?.languageModel;
}

/** Checks not just "does the API surface exist" but "is the model actually
 *  ready right now" — the same distinction already made for the translator
 *  below. A bare existence check overclaims readiness: the API object can
 *  be present while the underlying model is still downloadable/downloading,
 *  in which case create() can fail fast instead of doing real inference —
 *  confirmed directly via real-browser testing, not something a Node
 *  script surfaces. Falls back to the old existence-only check on browsers
 *  whose LanguageModel doesn't expose availability() at all. */
export async function isOnDeviceModelAvailable(): Promise<boolean> {
  const api = getLanguageModelAPI();
  if (!api) return false;
  if (!api.availability) return true;
  try {
    const status = await withTimeout(
      api.availability({ expectedOutputs: [{ type: "text", languages: ["en"] }] }),
      3000,
      "On-device model availability check",
    );
    return status === "available" || status === "readily";
  } catch {
    return false;
  }
}

/** Runs the prompt through Chrome's on-device model, if present. Real
 *  measured latency — do not hardcode a number here. */
export async function resolveWithOnDeviceModel(prompt: string): Promise<ResolutionResult> {
  const api = getLanguageModelAPI();
  if (!api) {
    throw new Error("No on-device model available in this browser.");
  }

  const start = performance.now();
  // Chrome now expects an explicit output language declaration — omitting
  // it isn't just a missed-quality-optimization warning, it fails the
  // request outright on current Chrome builds (discovered via real-browser
  // testing, not something a Node script could ever catch). "en" is a
  // reasonable default since this whole path only runs on text that made
  // it past the classifier's English-oriented keyword heuristics anyway;
  // revisit if/when non-English prompts become a real input case.
  const session = await withTimeout(
    api.create({ expectedOutputs: [{ type: "text", languages: ["en"] }] }),
    8000,
    "On-device model session creation",
  );
  try {
    const output = await withTimeout(session.prompt(prompt), 15000, "On-device model prompt");
    const latencyMs = performance.now() - start;
    return { output, latencyMs, mode: "on-device-model" };
  } finally {
    session.destroy?.();
  }
}

// --- On-device translation path (Chrome's Translator API) ------------------
//
// Deliberately a SEPARATE API from the Prompt API above — Translator is a
// purpose-built, smaller model family, not general LLM reasoning. As of
// this writing it's still gated to Chrome's built-in-AI Early Preview
// Program (not on by default for every Chrome user) and downloads a
// language-pair model (1-2GB) on first use per language pair — real,
// meaningful friction the classifier/UI should account for, not gloss
// over. Feature-detect the same defensive way as the Prompt API above:
// assume nothing is available until proven otherwise at runtime.

type TranslatorSession = { translate: (input: string) => Promise<string>; destroy?: () => void };
type TranslatorAPI = {
  availability: (opts: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (opts: { sourceLanguage: string; targetLanguage: string }) => Promise<TranslatorSession>;
};

function getTranslatorAPI(): TranslatorAPI | undefined {
  return (window as unknown as { Translator?: TranslatorAPI }).Translator;
}

/** Checks not just "does the API exist" but "is this specific language pair
 *  actually usable right now" — availability() can return states like
 *  'downloadable' (needs the model fetched first) or 'unavailable', not
 *  just yes/no, so a bare typeof check would overclaim readiness. */
export async function isTranslatorAvailable(targetLanguageCode: string, sourceLanguageCode = "en"): Promise<boolean> {
  const api = getTranslatorAPI();
  if (!api) return false;
  try {
    const status = await withTimeout(
      api.availability({ sourceLanguage: sourceLanguageCode, targetLanguage: targetLanguageCode }),
      3000,
      "Translator availability check",
    );
    return status === "available" || status === "readily";
  } catch {
    return false;
  }
}

/** Pulls the text to translate out of the prompt — everything after a
 *  colon, or a quoted span, since the translate instruction itself
 *  ("switch this to Spanish") isn't what should get translated. Returns
 *  null if there's genuinely nothing to translate (e.g. a bare "switch
 *  this to Spanish" with no content attached) — that's correctly
 *  unresolvable locally, not a bug to paper over. */
export function extractTranslatableText(prompt: string): string | null {
  const quoted = prompt.match(/["'"]([^"'"]{2,})["'"]/);
  if (quoted) return quoted[1].trim();

  const afterColon = prompt.split(":").slice(1).join(":").trim();
  if (afterColon) return afterColon;

  return null;
}

export async function resolveWithTranslator(text: string, targetLanguageCode: string, sourceLanguageCode = "en"): Promise<ResolutionResult> {
  const api = getTranslatorAPI();
  if (!api) {
    throw new Error("No on-device translator available in this browser.");
  }

  const start = performance.now();
  const session = await withTimeout(
    api.create({ sourceLanguage: sourceLanguageCode, targetLanguage: targetLanguageCode }),
    8000,
    "Translator session creation",
  );
  try {
    const output = await withTimeout(session.translate(text), 8000, "Translation");
    const latencyMs = performance.now() - start;
    return { output, latencyMs, mode: "on-device-translator" };
  } finally {
    session.destroy?.();
  }
}

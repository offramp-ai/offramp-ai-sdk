// The actual "drop-in wrapper" from the original plan — everything else in
// src/lib/ is the engine (classifier, resolvers, PII scanner); this is the
// single entry point a developer would actually call, shaped like the SDK
// clients it's meant to sit in front of (new Anthropic({...}) ->
// client.messages.create(...) becomes createOfframpClient({...}) ->
// offramp.resolve(...)).
//
// Four things this is deliberately built around:
//
// 1. Offramp never holds a cloud API key or makes a cloud call itself.
//    cloudFallback is a function YOU provide, wired to your own already-
//    configured client. That's not a limitation — it's what keeps this
//    zero-egress-by-construction rather than zero-egress-by-policy: there's
//    no code path here that could leak a prompt to Offramp's own servers,
//    because Offramp doesn't have any servers in this picture at all.
//
// 2. onResolution fires aggregate event data only — category, whether it
//    resolved locally, latency — never prompt text or output. Same rule as
//    the public demo's telemetry, for the same reason: whatever you wire
//    this to (your own analytics, your own DB) shouldn't become a place
//    prompt content leaks to just because you wanted usage numbers.
//
// 3. resolve() never throws because of local resolution failing — a failed
//    or unavailable local attempt always falls through to cloudFallback.
//    It DOES propagate errors from cloudFallback itself; that's your cloud
//    call, your error handling.
//
// 4. One deliberate, stated exception to "zero network calls": every
//    resolve() reports one aggregate usage event (category + booleans,
//    same shape as onResolution, never prompt content) to Offramp's own
//    metering backend. This is what makes consumption-based billing real.
//    It's a genuinely different claim from "your prompt data never leaves
//    your device," which stays true — worth stating plainly rather than
//    blurring the two. This call is fire-and-forget; a metering hiccup
//    never breaks resolve() for you.
//
// 5. Key revocation enforcement piggybacks on that same metering call
//    rather than adding a separate check-before-every-resolve() round
//    trip — that would cost real latency on the exact thing this product
//    sells being fast. Instead, each metering response updates an internal
//    "is this key still good" flag that gates the NEXT call's local
//    resolution. Enforcement therefore kicks in one call late, which is a
//    fair trade against paying a network round trip on every single call.
//    Critically: only an explicit "this key is invalid" response flips
//    that flag off. A network hiccup or Offramp's own server having a bad
//    moment must NEVER be treated as "revoked" — that would mean an
//    outage on Offramp's end quietly breaks local resolution for every
//    customer at once, which is a far worse failure mode than one call's
//    delay in catching an actually-revoked key.

import { classify, type TaskCategory } from "./classifier";
import { scanAndRedact } from "./pii";
import {
  resolveJsonLocally,
  resolveHtmlLocally,
  resolveWithOnDeviceModel,
  isOnDeviceModelAvailable,
  resolveWithTranslator,
  isTranslatorAvailable,
  extractTranslatableText,
} from "./localResolvers";
import { isValidJson, isCleanOfHtml } from "./validity";

// Re-exported for anyone who wants the individual pieces directly (e.g.
// just the PII scanner, or just the classifier) rather than the whole
// wrapper — createOfframpClient below is the primary entry point most
// people want, but the engine underneath isn't hidden.
export { classify, type TaskCategory, type Classification } from "./classifier";
export { scanAndRedact, type PiiSpan } from "./pii";
export {
  resolveJsonLocally,
  resolveHtmlLocally,
  resolveWithOnDeviceModel,
  isOnDeviceModelAvailable,
  resolveWithTranslator,
  isTranslatorAvailable,
  extractTranslatableText,
  type ResolutionResult,
} from "./localResolvers";
export { isValidJson, isCleanOfHtml } from "./validity";

export interface ResolutionEvent {
  category: TaskCategory;
  resolvedLocally: boolean;
  /** True only on a genuine local-resolution error (API threw, timed out)
   *  — not "wasn't eligible." Those are different questions: this field
   *  answers "is something actually broken," resolvedLocally answers "was
   *  this in scope for local resolution at all." Conflating them either
   *  hides real problems in normal coverage-gap noise or cries wolf on
   *  expected behavior. */
  attemptFailed: boolean;
  piiRedacted: boolean;
  latencyMs: number;
  timestamp: string;
  /** Only present when using a test key (offramp_test_...). The real,
   *  verified "would this have resolved locally" signal — computed by
   *  actually running the full classify/resolve/validate pipeline, same as
   *  a live key — but never substituted for the real output. See
   *  OfframpResult.wouldResolveLocally for why this distinction exists. */
  wouldResolveLocally?: boolean;
}

export interface OfframpResult {
  output: string;
  resolvedLocally: boolean;
  category: TaskCategory;
  latencyMs: number;
  source: "rule-based" | "on-device-model" | "on-device-translator" | "cloud";
  /** Only present when using a test key. A test key runs the real
   *  classify/resolve/validate pipeline to get a genuine answer to "would
   *  this prompt resolve locally" — including really calling the on-device
   *  model where applicable, not just checking category eligibility — but
   *  `output`/`resolvedLocally`/`source` above always reflect what actually
   *  happened (cloudFallback's answer, every time), so integrating this SDK
   *  can never change your app's behavior before you're ready. This field
   *  carries the real verified signal separately, for exactly that reason:
   *  resolvedLocally stays honest about what you actually got back,
   *  wouldResolveLocally tells you what a live key would have done. */
  wouldResolveLocally?: boolean;
}

const DEFAULT_API_BASE_URL = "https://offramp-ai.com";

export interface OfframpClientOptions {
  /** Required — issued per customer for usage-based billing during this
   *  early manual-onboarding phase (no self-serve signup yet). */
  apiKey: string;
  /** Override for local development/testing against a non-production
   *  Offramp backend. Defaults to the production metering endpoint. */
  apiBaseUrl?: string;
  /** Called only when local resolution isn't eligible or fails. Wire this
   *  to your own already-configured Anthropic/OpenAI/etc client — e.g.
   *  `(prompt) => anthropic.messages.create({...}).then(r => r.content...)`. */
  cloudFallback: (prompt: string) => Promise<string>;
  /** Fires after every resolve() call, local or cloud. Aggregate data only. */
  onResolution?: (event: ResolutionEvent) => void;
  /** Default true. Redacts SSNs, emails, credit cards, phone numbers, and
   *  IP addresses before ANY resolution attempt — local or cloud. */
  redactPii?: boolean;
}

/** Fire-and-forget — never block resolve() on Offramp's own metering
 *  endpoint being reachable. A billing hiccup should never break the
 *  product for the developer using it. onKeyValidityKnown fires ONLY on an
 *  unambiguous signal (a real 401 or 429, or a real success) — never on a
 *  network error or any other failure, since those aren't evidence the key
 *  is actually invalid.
 *
 *  429 (monthly free-tier call cap exceeded) is treated exactly like 401
 *  (key revoked) here — both mean "stop attempting local resolution for
 *  this key until further notice." Self-heals automatically the same way
 *  a reactivated key does: once the billing period rolls over server-side,
 *  the next call's response is a real 200 again. */
function reportMeterEvent(
  apiBaseUrl: string,
  apiKey: string,
  category: TaskCategory,
  resolvedLocally: boolean,
  attemptFailed: boolean,
  piiRedacted: boolean,
  onKeyValidityKnown: (valid: boolean) => void,
): void {
  fetch(`${apiBaseUrl}/api/meter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ category, resolvedLocally, attemptFailed, piiRedacted }),
    keepalive: true,
  })
    .then((res) => {
      if (res.status === 401 || res.status === 429) onKeyValidityKnown(false);
      else if (res.ok) onKeyValidityKnown(true);
      // Any other status (5xx, etc.) says nothing about key validity —
      // deliberately not treated as a signal either way.
    })
    .catch(() => {
      // Network failure — same reasoning, not evidence of anything.
    });
}

export interface OfframpClient {
  resolve(prompt: string): Promise<OfframpResult>;
}

export function createOfframpClient(options: OfframpClientOptions): OfframpClient {
  const { apiKey, apiBaseUrl = DEFAULT_API_BASE_URL, cloudFallback, onResolution, redactPii = true } = options;
  // Stripe's own pattern (sk_test_/sk_live_) — the key string itself is the
  // source of truth for test-vs-live, never a client-settable option. That
  // matters once real billing exists: a boolean a developer could leave
  // flipped on in production would be a way to silently dodge every
  // charge, forever. A separate issued key closes that off entirely.
  const isTestKey = apiKey.startsWith("offramp_test_");

  // Starts optimistic (true) so the very first call doesn't need a
  // blocking pre-check before it can attempt local resolution. Updated
  // asynchronously by each call's metering response — see
  // reportMeterEvent's onKeyValidityKnown. A reactivated key self-heals on
  // its next call automatically, no extra request needed for that either.
  let keyKnownValid = true;

  async function resolve(prompt: string): Promise<OfframpResult> {
    const start = performance.now();

    const redaction = redactPii ? scanAndRedact(prompt) : null;
    const workingText = redaction ? redaction.redacted : prompt;
    const piiRedacted = Boolean(redaction && redaction.spans.length > 0);

    const classification = classify(workingText);

    let resolvedLocally = false;
    let attemptFailed = false;
    let output: string | null = null;
    let source: OfframpResult["source"] = "cloud";

    // A key already known invalid (from a previous call's metering
    // response) skips local resolution entirely — no point doing the work
    // just to discard it. cloudFallback still runs regardless; revocation
    // only gates the paid, differentiated local-resolution feature, never
    // your app's ability to function at all.
    if (!keyKnownValid) {
      // falls through to cloudFallback below, same as "other" category
    } else if (classification.category === "json") {
      try {
        const r = resolveJsonLocally(workingText);
        if (isValidJson(r.output)) {
          output = r.output;
          resolvedLocally = true;
          source = "rule-based";
        }
      } catch {
        attemptFailed = true;
      }
    } else if (classification.category === "html") {
      try {
        const r = resolveHtmlLocally(workingText);
        if (isCleanOfHtml(r.output)) {
          output = r.output;
          resolvedLocally = true;
          source = "rule-based";
        }
      } catch {
        attemptFailed = true;
      }
    } else if (classification.category === "summarize") {
      if (await isOnDeviceModelAvailable()) {
        try {
          const r = await resolveWithOnDeviceModel(workingText);
          output = r.output;
          resolvedLocally = true;
          source = "on-device-model";
        } catch {
          attemptFailed = true;
        }
      }
    } else if (classification.category === "translate" && classification.targetLanguageCode) {
      const text = extractTranslatableText(workingText);
      if (text && (await isTranslatorAvailable(classification.targetLanguageCode))) {
        try {
          const r = await resolveWithTranslator(text, classification.targetLanguageCode);
          output = r.output;
          resolvedLocally = true;
          source = "on-device-translator";
        } catch {
          attemptFailed = true;
        }
      }
    }
    // "other" always falls through — never attempts local resolution, by
    // design, same as the demo.

    // The real, verified "would this have resolved locally" signal —
    // captured before anything below can override it. For a live key this
    // is just resolvedLocally; the distinction only matters in test mode.
    const wouldResolveLocally = resolvedLocally;

    if (!resolvedLocally || isTestKey) {
      // Test keys ALWAYS call cloudFallback and return its answer, even
      // when local resolution just succeeded above — the whole point of a
      // test key is proving out what WOULD happen without ever actually
      // changing what your app gets back. Discard whatever local output
      // was computed; it was only ever for the wouldResolveLocally signal.
      output = await cloudFallback(workingText);
      source = "cloud";
      resolvedLocally = false;
    }

    const latencyMs = performance.now() - start;

    // Metering always carries the TRUE signal (wouldResolveLocally), not
    // the test-mode-overridden one — this is what lets the dashboard show
    // "here's what a live key would have saved you" from test traffic.
    reportMeterEvent(apiBaseUrl, apiKey, classification.category, wouldResolveLocally, attemptFailed, piiRedacted, (valid) => {
      keyKnownValid = valid;
    });

    onResolution?.({
      category: classification.category,
      resolvedLocally,
      attemptFailed,
      piiRedacted,
      latencyMs,
      timestamp: new Date().toISOString(),
      ...(isTestKey ? { wouldResolveLocally } : {}),
    });

    return {
      output: output as string,
      resolvedLocally,
      category: classification.category,
      latencyMs,
      source,
      ...(isTestKey ? { wouldResolveLocally } : {}),
    };
  }

  return { resolve };
}

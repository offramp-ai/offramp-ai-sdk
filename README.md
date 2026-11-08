# offramp-ai-sdk

Resolves eligible prompts on-device instead of the cloud — a drop-in wrapper around whatever LLM API call your app already makes. Lower latency for eligible prompts (JSON conversion, HTML cleanup, and more) as they're resolved locally, with their content never reaching Offramp or any third-party cloud server. PII is redacted before anything happens, local or cloud, every time. Everything that isn't eligible falls through to your own cloud API automatically, unchanged.

**Live demo** (no login, paste a real prompt, see where it actually resolves and why): https://offramp-production-04cc.up.railway.app

This code is public so you can read exactly what it does before depending on it — it is **not open source**; see [License](#license) below.

## Get an API key

Free, self-serve, no card required:

👉 https://offramp-production-04cc.up.railway.app/signup

Just an email address. You get **two** keys back immediately — a live key and a paired test key — and can start calling `resolve()` right away with either, no approval step. (If you lose them, sign up again with the same email to get them back — there's no separate retrieval page yet.)

## Test keys

Start with the test key (`offramp_test_...`). It runs the real classify/resolve/validate pipeline — including actually calling Chrome's on-device model where available — so `result.wouldResolveLocally` is a genuine, verified answer to "how much of my traffic would resolve locally," not a category-eligibility guess. But `resolve()` on a test key **always returns your `cloudFallback`'s answer**, regardless of what local resolution determined — installing this can never change what your app actually returns until you deliberately switch to the live key (`offramp_...`, no `test_`). Same pattern as Stripe's `sk_test_`/`sk_live_` — which mode you're in is determined by which key you pass, never by a setting your own code could accidentally leave on in production.

## Install

```bash
npm install offramp-ai-sdk
```

## Usage

```ts
import { createOfframpClient } from "offramp-ai-sdk";

const offramp = createOfframpClient({
  apiKey: "YOUR_API_KEY_HERE", // use your test key (offramp_test_...) first

  // Called only when a prompt isn't eligible for local resolution, or a
  // local attempt fails. Wire this to your own already-configured
  // Anthropic/OpenAI/etc client — Offramp never holds your cloud API key
  // and never calls a cloud API itself.
  cloudFallback: async (prompt) => {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    return res.content[0].text;
  },

  // Optional — fires after every resolve() call with aggregate data only
  // (category, resolvedLocally, latency — never prompt text or output).
  onResolution: (event) => {
    console.log(event);
  },
});

const result = await offramp.resolve(userPrompt);
console.log(result.output, result.resolvedLocally);
// On a test key: result.output is always your cloud answer, and
// result.wouldResolveLocally tells you what a live key would have done.
```

This only runs in a browser environment — `resolve()` uses browser-only APIs (Chrome's on-device Prompt/Translator APIs, `DOMParser`) for some of its resolution paths, so it won't work called from plain Node.js.

## What actually happens on `resolve()`

1. PII (SSNs, emails, credit cards, phone numbers, IP addresses) is redacted — on by default, `redactPii: false` to disable.
2. The redacted text is classified (`json` / `html` / `summarize` / `translate` / `other`) using a deterministic, inspectable rule set — no model call for this step.
3. `json`/`html` resolve via pure string transforms — works in **any** browser, no model dependency at all.
4. `summarize`/`translate` resolve via Chrome's on-device AI (the Prompt API and Translator API respectively) *when it's actually available* — **Chrome only** right now, and gated behind real hardware/OS requirements (macOS 13+ or equivalent, 4GB+ GPU VRAM). On any other browser, or an unsupported machine, these two categories correctly fall through to `cloudFallback` — that's expected behavior, not a bug.
5. Anything not resolved locally falls through to your `cloudFallback`, unchanged.
6. One aggregate usage event (category + pass/fail booleans, **never prompt content**) is reported to Offramp for billing. This is the one deliberate exception to "zero network calls" — your prompt *data* never reaches Offramp's servers either way (local resolution or cloud fallback), and that's a real, separate claim worth stating plainly rather than blurring the two. (Your cloud fallback's own destination — Anthropic, OpenAI, whichever you configured — is a different matter entirely; Offramp never sees or touches that traffic.)

## Usage limits

Free to use — no card, no billing setup, nothing to configure. There's a generous anti-abuse cap behind the scenes (not a paywall — there's no paid plan yet), high enough that normal evaluation or prototyping won't come close to it. If you're actually scaling past it, reach out.

If you do cross it, `resolve()` keeps working exactly as before — `cloudFallback` always runs regardless — you just lose the on-device optimization for that key until the billing period (calendar month) rolls over. Nothing breaks.

## Browser support

| Resolution path | Requires |
|---|---|
| PII redaction | Any browser — plain JS |
| `json` / `html` | Any browser — plain parsing, no model |
| `summarize` | Chrome only, on-device model (macOS 13+/Windows/ChromeOS equivalent, 4GB+ GPU VRAM) |
| `translate` | Chrome only, on-device translator (separate feature gate + per-language download) |

## License

Proprietary — all rights reserved. The source is public for transparency and auditability, not for reuse: no permission is granted to copy, modify, redistribute, or build a competing product from this code. Using the *hosted service* requires an issued API key and is subject to these terms. See [`LICENSE`](./LICENSE) and `package.json`'s `"license": "UNLICENSED"`.

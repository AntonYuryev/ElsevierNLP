// ── LLM connector ─────────────────────────────────────────────────────────────
// Shared helper for calling the configured LLM provider.
// Settings (llmProviderUrl, llmApiKey, llmModel, llmTemperature, llmTopP) are
// read from window.api.settings.get() at call time so they're always current.
//
// Provider detection (by URL):
//   anthropic.com                          → Anthropic Messages API
//   generativelanguage.googleapis.com      → Gemini native generateContent API
//                                            (Google Search grounding always enabled;
//                                             routed via main-process IPC to avoid CORS)
//   anything else                          → OpenAI-compatible Chat Completions API
//
// Which LLM: overrides.fn = the id of the calling function (shared/llmFunctions.js). Settings → LLM Connector / Local LLM let the user choose, per function, the LLM provider
// ('api', the default) or the local Ollama server ('local': its port, model and context window from Settings → Local LLM). No fn = the provider.
//
// Usage:
//   import { callLlm } from '../../shared/llm';
//   const reply = await callLlm(messages, { fn: 'suggest.design' });

import { llmTargetOf } from './llmFunctions';

// ── Daily request counter ─────────────────────────────────────────────────────
// Every callLlm() request is counted per local calendar day (persisted in
// localStorage) and checked against Settings → "Max LLM requests per day".
const USAGE_KEY = 'llmDailyUsage';
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export function getLlmUsageToday() {
  try {
    const u = JSON.parse(localStorage.getItem(USAGE_KEY));
    if (u && u.date === todayKey()) return Number(u.count) || 0;
  } catch {}
  return 0;
}

function addLlmUsage(n = 1) {
  localStorage.setItem(USAGE_KEY, JSON.stringify({ date: todayKey(), count: getLlmUsageToday() + n }));
}

// Requests still available today (null settings value → default 1000)
export async function getLlmRemainingToday() {
  const s = await window.api.settings.get();
  const limit = Math.max(1, s?.llmMaxRequestsPerDay ?? 1000);
  return { limit, used: getLlmUsageToday(), remaining: Math.max(0, limit - getLlmUsageToday()) };
}

// "name: value" lines (e.g. "x-portkey-provider: google") → { name: value }. Lines without a colon are ignored.
export function parseExtraHeaders(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const name = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

// ── The local Ollama server (native /api/chat: honours the context window) — not counted against the daily limit of the provider ──────────────────
async function callLocalLlm(s, messages, overrides) {
  const port  = Math.max(1, parseInt(s?.llmLocalPort) || 11434);
  const model = overrides.model || s?.llmLocalModel || '';
  if (!model) throw new Error('No local LLM model chosen (Settings → Local LLM → "Model for the functions set to Local LLM").');
  const temperature = overrides.temperature ?? s?.llmTemperature ?? 0.2;
  const top_p       = overrides.topP        ?? s?.llmTopP        ?? 0.9;
  let data;
  try {
    data = await window.api.llm.fetch({
      url: `http://127.0.0.1:${port}/api/chat`,
      body: {
        model, messages, stream: false,
        ...(overrides.json ? { format: 'json' } : {}),
        options: { temperature, top_p, num_ctx: Math.max(256, parseInt(s?.llmLocalNumCtx) || 4096, overrides.minNumCtx || 0), num_predict: overrides.maxTokens ?? 4096 },
      },
    });
  } catch (e) {
    throw new Error(`Local LLM (port ${port}, model ${model}): ${e.message}. Is the SSH tunnel open? (Settings → Local LLM)`);
  }
  return data.message?.content ?? '';
}

export async function callLlm(messages, overrides = {}) {
  const s = await window.api.settings.get();
  if (overrides.fn && llmTargetOf(s, overrides.fn) === 'local') return callLocalLlm(s, messages, overrides);
  {
    const limit = Math.max(1, s?.llmMaxRequestsPerDay ?? 1000);
    if (getLlmUsageToday() >= limit)
      throw new Error(`Daily LLM request limit reached (${limit}). Increase it in Settings → LLM Connector.`);
    addLlmUsage();
  }
  const url         = overrides.url   ?? s?.llmProviderUrl ?? '';
  const key         = overrides.key   ?? s?.llmApiKey      ?? '';
  const model       = overrides.model ?? s?.llmModel       ?? '';
  const temperature = overrides.temperature ?? s?.llmTemperature ?? 0.2;
  const top_p       = overrides.topP        ?? s?.llmTopP        ?? 0.9;
  // Custom auth header: if set, used as-is (e.g. "x-portkey-api-key").
  // If empty, falls back to standard "Authorization: Bearer {key}".
  const authHeader  = overrides.authHeader  ?? s?.llmAuthHeader  ?? '';
  // further headers some gateways need next to the key (e.g. Portkey: x-portkey-provider or x-portkey-config)
  const extraHeaders = parseExtraHeaders(overrides.extraHeaders ?? s?.llmExtraHeaders ?? '');


  if (!url)   throw new Error('LLM provider URL not configured (Settings → LLM Connector).');
  if (!key)   throw new Error('LLM API key not configured (Settings → LLM Connector).');
  if (!model) throw new Error('No LLM model selected (Settings → LLM Connector).');

  const isAnthropic = url.includes('anthropic.com');
  const isGemini    = url.includes('generativelanguage.googleapis.com');

  // ── Anthropic Messages API ────────────────────────────────────────────────
  if (isAnthropic) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const rest   = messages.filter(m => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  }

  // ── Gemini native generateContent API ─────────────────────────────────────
  // Always uses the native endpoint (not the OpenAI-compat shim) so that
  // Google Search grounding is available. Routed via main-process IPC to
  // avoid CORS restrictions on localhost renderer origins.
  if (isGemini) {
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs  = messages.filter(m => m.role !== 'system');

    // Map OpenAI roles → Gemini roles (assistant → model)
    const contents = userMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body = {
      ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
      contents,
      // Google Search grounding — lets the model look up authoritative sources
      // (EcoliWiki, EcoCyc, UniProt, NCBI Gene, etc.) at inference time.
      // Equivalent to types.Tool(google_search=types.GoogleSearch()) in the Python SDK.
      // overrides.grounding === false: plain generation (no search tool) — needed for strict JSON replies
      ...(overrides.grounding === false ? {} : { tools: [{ google_search: {} }] }),
      generation_config: {
        temperature, max_output_tokens: overrides.maxTokens ?? 2048,
        ...(overrides.json ? { response_mime_type: 'application/json' } : {}),
      },
    };

    // Strip any leading "models/" from the model string — the endpoint already
    // adds it, so "models/gemini-2.0-flash" in settings would double it.
    const modelName = model.replace(/^models\//, '');
    const endpoint  = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;

    const data = await window.api.llm.fetch({ url: endpoint, body });
    return data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  }

  // ── OpenAI-compatible Chat Completions API ────────────────────────────────
  // Routed via main-process IPC (window.api.llm.fetch) to avoid CORS issues
  // with gateways that don't set Access-Control-Allow-Origin headers.
  // the base URL may be given as the full endpoint (…/v1/chat/completions, as in gateway examples): never append the path twice
  const base = url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  // Build auth headers: custom header (e.g. "x-portkey-api-key") or standard Bearer.
  const authHeaders = {
    ...extraHeaders,
    ...(authHeader ? { [authHeader]: key } : { 'Authorization': `Bearer ${key}` }),
  };
  const data = await window.api.llm.fetch({
    url: `${base}/chat/completions`,
    headers: authHeaders,
    // Only include temperature / top_p when they differ from the model's implicit
    // default (1 / 1). Some models (e.g. gpt-5.6-luna via Portkey) reject any
    // explicit value and return HTTP 400 "unsupported_value".
    body: {
      model, messages, max_completion_tokens: 4096,
      ...(temperature != null && temperature !== 1  ? { temperature } : {}),
      ...(top_p       != null && top_p       !== 1  ? { top_p }       : {}),
    },
  });
  return data.choices?.[0]?.message?.content ?? '';
}

// Vercel Serverless Function — secure proxy to the Google Gemini API.
//
// WHY THIS EXISTS:
//   The frontend (index.html) must NOT hold the API key — it is a public,
//   browser-served file, and a browser cannot call the Gemini API directly
//   without exposing the key. This function runs server-side on Vercel, reads
//   the key from the GEMINI_API_KEY environment variable, forwards the request
//   to Gemini, and returns { text }.
//
// CONTRACT (unchanged, so the frontend did not need to change its call shape):
//   Request  (POST, JSON): { prompt: string, max_tokens?: number, model?: string }
//   Response (200, JSON):  { text: string }
//   Errors   (JSON):       { error: { type, message } } with the UPSTREAM status
//                          code preserved (429 / 5xx) so the frontend retry
//                          logic can classify transient failures correctly.
//
// SETUP (one-time, in the Vercel dashboard):
//   1. Get a free key at https://aistudio.google.com/apikey  (starts with "AIza...")
//   2. Vercel > Project > Settings > Environment Variables > add
//        GEMINI_API_KEY = AIza...      (do NOT commit this anywhere)
//   3. Redeploy.

var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
var DEFAULT_MODEL = 'gemini-2.0-flash';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { type: 'method_not_allowed', message: 'Use POST.' } });
  }

  var key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { type: 'config_error', message: 'GEMINI_API_KEY is not set on the server.' }
    });
  }

  // Body may arrive already parsed (object) or as a raw string depending on the
  // runtime / content-type. Handle both without throwing.
  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') { body = {}; }

  var prompt = body.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: { type: 'invalid_request', message: 'Missing "prompt".' } });
  }
  var maxTokens = Number(body.max_tokens) > 0 ? Math.floor(Number(body.max_tokens)) : 1024;
  var model = (typeof body.model === 'string' && body.model.trim()) ? body.model.trim() : DEFAULT_MODEL;
  // Safety guard: if an old Anthropic model id ever reaches here, use the Gemini default.
  if (/claude/i.test(model)) { model = DEFAULT_MODEL; }

  try {
    var upstream = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key   // key sent as a header (kept out of the URL/logs)
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // maxOutputTokens preserves the per-call budget the frontend asked for;
        // temperature 0.7 keeps output focused and professional for JD content.
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
      })
    });

    var raw = await upstream.text();
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { /* non-JSON upstream body */ }

    if (!upstream.ok || (data && data.error)) {
      var em = (data && data.error && (data.error.message || data.error.status)) || ('HTTP ' + upstream.status);
      var et = (data && data.error && (data.error.status || data.error.type)) || 'upstream_error';
      // Preserve the upstream status so the client can retry transient errors.
      return res.status(upstream.status || 502).json({ error: { type: et, message: em } });
    }

    // If the prompt itself was blocked by safety filters, surface it (never fall back).
    if (data && data.promptFeedback && data.promptFeedback.blockReason) {
      return res.status(502).json({ error: { type: 'blocked', message: 'Blocked: ' + data.promptFeedback.blockReason } });
    }

    // Gemini success shape: candidates[].content.parts[].text
    var text = '';
    if (data && Array.isArray(data.candidates)) {
      data.candidates.forEach(function (c) {
        if (c && c.content && Array.isArray(c.content.parts)) {
          c.content.parts.forEach(function (p) { if (p && typeof p.text === 'string') text += p.text; });
        }
      });
    }
    text = text.trim();
    if (!text) {
      return res.status(502).json({ error: { type: 'empty_response', message: 'No text returned by the model.' } });
    }

    return res.status(200).json({ text: text });
  } catch (err) {
    return res.status(502).json({ error: { type: 'proxy_error', message: (err && err.message) || 'fetch failed' } });
  }
};

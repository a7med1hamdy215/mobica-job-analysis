// Vercel Serverless Function — secure proxy to the Anthropic Messages API.
//
// WHY THIS EXISTS:
//   The frontend (index.html) must NOT hold the Anthropic API key — it is a
//   public, browser-served file. A browser also cannot call api.anthropic.com
//   directly (CORS + the key would be exposed). This function runs server-side
//   on Vercel, reads the key from the ANTHROPIC_API_KEY environment variable,
//   forwards the request to Anthropic, and returns { text }.
//
// CONTRACT:
//   Request  (POST, JSON): { prompt: string, max_tokens?: number, model?: string }
//   Response (200, JSON):  { text: string }
//   Errors   (JSON):       { error: { type, message } } with the UPSTREAM status
//                          code preserved (429/5xx/529) so the frontend retry
//                          logic can classify transient failures correctly.
//
// SETUP (one-time, done by the project owner in the Vercel dashboard):
//   Project Settings > Environment Variables > add
//     ANTHROPIC_API_KEY = sk-ant-...   (do NOT commit this anywhere)
//   then redeploy.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { type: 'method_not_allowed', message: 'Use POST.' } });
  }

  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { type: 'config_error', message: 'ANTHROPIC_API_KEY is not set on the server.' }
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
  var model = (typeof body.model === 'string' && body.model.trim()) ? body.model.trim() : 'claude-sonnet-4-20250514';

  try {
    var upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    var raw = await upstream.text();
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { /* non-JSON upstream body */ }

    if (!upstream.ok || (data && data.error)) {
      var em = (data && data.error && (data.error.message || data.error.type)) || ('HTTP ' + upstream.status);
      var et = (data && data.error && data.error.type) || 'upstream_error';
      // Preserve the upstream status so the client can retry transient errors.
      return res.status(upstream.status || 502).json({ error: { type: et, message: em } });
    }

    var text = '';
    if (data && Array.isArray(data.content)) {
      data.content.forEach(function (b) { if (b && b.type === 'text' && typeof b.text === 'string') text += b.text; });
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

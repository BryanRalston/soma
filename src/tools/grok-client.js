// ============================================================
// GROK CLIENT — Self-contained xAI API HTTP client
// No external dependencies — uses Node.js built-in `https`.
//
// Interface:
//   streamGrokChat({ messages, model, temperature, onDelta, onDone, onError })
//     → Promise<string>  (resolves with full response text)
//
// Configuration:
//   API key: XAI_API_KEY environment variable
//   Model:   defaults to 'grok-3-mini'
//   Endpoint: https://api.x.ai/v1/chat/completions (OpenAI-compatible)
// ============================================================

'use strict';

const https = require('https');

const XAI_API_BASE = 'api.x.ai';
const XAI_CHAT_PATH = '/v1/chat/completions';

/**
 * Call the xAI chat completions API with optional streaming.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages   - Conversation messages
 * @param {string}   [opts.model='grok-3-mini']                    - Model ID
 * @param {number}   [opts.temperature=0.7]                        - Sampling temperature
 * @param {function} [opts.onDelta]   - Called with each streamed text chunk (string)
 * @param {function} [opts.onDone]    - Called with full response text when complete
 * @param {function} [opts.onError]   - Called with Error on stream/parse failure
 * @returns {Promise<string>}  Resolves with the complete assistant response text.
 */
function streamGrokChat({ messages, model, temperature, onDelta, onDone, onError }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error('XAI_API_KEY environment variable is not set'));
  }

  const resolvedModel = model || 'grok-3-mini';
  const resolvedTemp  = (typeof temperature === 'number') ? temperature : 0.7;

  const body = JSON.stringify({
    model: resolvedModel,
    messages,
    temperature: resolvedTemp,
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: XAI_API_BASE,
      path:     XAI_CHAT_PATH,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = '';
        res.on('data', (c) => (errBody += c));
        res.on('end', () => {
          const err = new Error(
            `xAI API error ${res.statusCode}: ${errBody.slice(0, 200)}`
          );
          if (onError) onError(err);
          reject(err);
        });
        return;
      }

      let fullText = '';
      let buffer   = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        // SSE lines: each line is "data: {...}" or "data: [DONE]"
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // skip malformed SSE frames
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            if (onDelta) onDelta(delta);
          }
        }
      });

      res.on('end', () => {
        // Flush any remaining buffer content
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim();
            if (payload && payload !== '[DONE]') {
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0) {
                  fullText += delta;
                  if (onDelta) onDelta(delta);
                }
              } catch {
                // ignore
              }
            }
          }
        }

        if (onDone) onDone(fullText);
        resolve(fullText);
      });

      res.on('error', (err) => {
        if (onError) onError(err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      if (onError) onError(err);
      reject(err);
    });

    req.setTimeout(120000, () => {
      req.destroy(new Error('xAI API request timed out after 120s'));
    });

    req.write(body);
    req.end();
  });
}

module.exports = { streamGrokChat };

/**
 * Studio AI — vision + text helpers for the in-browser template editor.
 * Refuses official-document forgery. Degrades without OPENAI_API_KEY.
 */
const OpenAI = require('openai');
const sharp = require('sharp');

function aiDisabled() { return process.env.CARD_AI_DISABLE === '1'; }
function aiConfigured() { return !!(process.env.OPENAI_API_KEY) && !aiDisabled(); }

function client(overrideKey) {
  const key = String(overrideKey || process.env.OPENAI_API_KEY || '').trim();
  if (!key || aiDisabled()) return null;
  return new OpenAI({ apiKey: key });
}

const FORBIDDEN = /passport|driver.?licen[cs]e|national.?id|government.?id|visa\b|green.?card|social.?security|birth.?cert|official.?id|forged|counterfeit/i;

const SYSTEM = [
  'You are DocsEditor Studio, a world-class graphic designer for marketing cards, event badges, membership cards, invitations, and fictional product mockups.',
  'You NEVER help create, improve, or disguise government IDs, passports, driver licenses, visas, or other official documents. If asked, refuse and suggest a clearly fictional demo instead.',
  'LIVE_TYPE layers are real Photoshop Type layers with fonts — those are the only strings you may rewrite via liveEdits. Raster/flattened pixels are not editable type. Preserve the original font unless the user asks to change it.',
  'Return ONLY JSON matching the requested schema. Be specific and actionable.',
].join(' ');

async function shrinkPreview(pngOrJpeg) {
  return sharp(pngOrJpeg)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
}

async function studioAsk({ imageBuffer, prompt, layers, mode, apiKey }) {
  if (FORBIDDEN.test(String(prompt || '')) || FORBIDDEN.test(String(mode || ''))) {
    return {
      ok: false,
      refused: true,
      message: 'This studio will not edit official identity documents. Use a fictional membership or event badge instead.',
    };
  }
  const ai = client(apiKey);
  if (!ai) {
    return { ok: false, code: 'AI_UNAVAILABLE', message: 'Add an OpenAI API key in Studio (or set OPENAI_API_KEY on the server). A GitHub token will not work.' };
  }

  const preview = await shrinkPreview(imageBuffer);
  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5-mini';
  const layerHint = Array.isArray(layers)
    ? layers.slice(0, 60).map((l, i) => {
        const kind = l.live ? 'LIVE_TYPE' : (l.text ? 'TEXT' : 'RASTER');
        return `${i}:${l.name || 'layer'} ${kind} font=${l.font || '-'} text=${JSON.stringify(String(l.text || '').slice(0, 80))} ${l.hidden ? 'hidden' : ''}`;
      }).join('\n')
    : '';

  const schemaHint = {
    summary: 'one sentence of what you see',
    liveEdits: [{ layer: 'exact live type layer name', from: 'current', to: 'replacement copy', keepFont: true }],
    placeholders: [{ token: '{{NAME}}', layer: 'layer name or null', x: 0, y: 0, note: '' }],
    suggestedEdits: [{ action: 'recolor|resize|replace-photo|rewrite-text|contrast|font', target: 'layer', detail: '' }],
    fillValues: { NAME: '', ROLE: '', ORG: '', TAGLINE: '' },
    filters: { brightness: 0, contrast: 0, saturate: 0, warmth: 0 },
    copy: { headline: '', subhead: '', cta: '' },
    tips: ['short designer tip'],
  };

  const res = await ai.chat.completions.create({
    model,
    max_completion_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Mode: ${mode || 'direct'}.`,
              `User request: ${String(prompt || 'Analyze this template and propose a premium redesign plan.').slice(0, 1200)}`,
              'Known layers:',
              layerHint || '(none listed)',
              'Return JSON with keys:',
              JSON.stringify(schemaHint),
            ].join('\n'),
          },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${preview.toString('base64')}` } },
        ],
      },
    ],
  });

  let data;
  try {
    data = JSON.parse(res.choices?.[0]?.message?.content || '{}');
  } catch {
    return { ok: false, code: 'AI_BAD_RESPONSE', message: 'AI returned unreadable data. Try again.' };
  }
  return { ok: true, ai: true, ...data };
}

module.exports = { studioAsk, aiConfigured, shrinkPreview };

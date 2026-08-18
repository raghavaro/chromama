// Claude API client.
//
// Two calls only:
//   proposeTaxonomy()  — rare, real judgment about the shape of the user's life
//   classifyTabs()     — mechanical pattern matching, batched, cached by URL
//
// Excluded domains are filtered by the CALLER (see organize.js) — this module
// never decides what is safe to send. That split is deliberate: the privacy
// filter should not live in the module whose job is to transmit.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const DEFAULT_MODEL = 'claude-opus-5';
export const CHEAP_MODEL = 'claude-haiku-4-5';

const BATCH_SIZE = 200; // keeps each response well under max_tokens

// ------------------------------------------------------------- key storage

const KEY_NAME = 'anthropicApiKey';

export async function getApiKey() {
  const stored = await chrome.storage.local.get(KEY_NAME);
  return stored[KEY_NAME] ?? '';
}

export async function setApiKey(key) {
  await chrome.storage.local.set({ [KEY_NAME]: String(key ?? '').trim() });
}

// ------------------------------------------------------------- transport

async function callClaude({ apiKey, model, system, userText, schema, maxTokens = 8000 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema } }
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Required for direct calls from a browser context.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message ?? JSON.stringify(err);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`Claude API ${res.status}: ${detail}`);
  }

  const data = await res.json();

  // Structured outputs still stop for other reasons — a refusal or a token cap
  // both yield content that will not match the schema. Check before parsing.
  if (data.stop_reason === 'refusal') {
    throw new Error(`Request declined by safety classifiers (${data.stop_details?.category ?? 'unknown'}).`);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Response hit max_tokens — batch too large. Lower BATCH_SIZE in ai.js.');
  }

  const text = data.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('No text block in response.');

  return {
    parsed: JSON.parse(text),
    usage: data.usage ?? {},
    model: data.model
  };
}

/** Rough token estimate for a set of tabs, for the cost preview. */
export function estimateTokens(tabs) {
  const chars = tabs.reduce((n, t) => n + (t.title?.length ?? 0) + (t.url?.length ?? 0), 0);
  return Math.ceil(chars / 3.5) + tabs.length * 6;
}

// --------------------------------------------------------- taxonomy proposal

const TAXONOMY_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['name', 'description', 'rationale'],
        additionalProperties: false
      }
    }
  },
  required: ['categories'],
  additionalProperties: false
};

const TAXONOMY_SYSTEM = `You organize a person's browser tabs into a small set of top-level topic categories.

These categories become browser WINDOWS, so they are macro-level: the broad areas of this person's life and work. Finer distinctions become tab groups inside a window and are not your concern here.

Rules:
- Propose 5 to 10 categories. Fewer is better than more.
- Base them on what is actually in these tabs, not on generic life categories. If half the tabs are one project, that project deserves a category.
- Each name is 1-3 words, the kind of label the person would use themselves.
- Categories must be distinguishable by someone reading only a tab's title and URL.
- Avoid a catch-all "Other" or "Misc" category. Unclassifiable tabs are handled separately.
- The person will edit these before anything is applied, so propose confidently rather than hedging.`;

export async function proposeTaxonomy({ apiKey, model = DEFAULT_MODEL, tabs }) {
  const lines = tabs.map((t, i) => `${i}\t${t.title ?? ''}\t${t.url ?? ''}`).join('\n');
  const userText =
    `Here are ${tabs.length} open tabs as "index<TAB>title<TAB>url".\n\n` +
    `${lines}\n\n` +
    `Propose the top-level topic categories that best fit this person's tabs.`;

  const { parsed, usage } = await callClaude({
    apiKey,
    model,
    system: TAXONOMY_SYSTEM,
    userText,
    schema: TAXONOMY_SCHEMA,
    maxTokens: 4000
  });

  return { categories: parsed.categories, usage };
}

// ------------------------------------------------------------ classification

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          category: { type: 'string' },
          group: { type: 'string' },
          confidence: { type: 'number' }
        },
        required: ['i', 'category', 'group', 'confidence'],
        additionalProperties: false
      }
    },
    proposedCategories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['name', 'description', 'rationale'],
        additionalProperties: false
      }
    }
  },
  required: ['assignments', 'proposedCategories'],
  additionalProperties: false
};

function classifySystem(categories) {
  const list = categories.map((c) => `- ${c.name}: ${c.description}`).join('\n');
  return `You assign browser tabs to a fixed set of topic categories, and to a finer sub-group within each.

The categories are FIXED. Use these exact names:

${list}

For every tab, return:
- "category": one of the exact names above.
- "group": a short (1-3 word) sub-group naming the specific task or project this tab belongs to, e.g. "tax filing", "rust learning", "chromama". Reuse the same group name across tabs that belong together — that is what makes grouping useful. Prefer an existing-sounding name over inventing a new one for a single tab.
- "confidence": 0.0-1.0.

Judgment notes:
- The domain is a prior, not the answer. A youtube.com tab may be a programming tutorial; a github.com tab may be someone's recipe repo. The title decides.
- If a tab genuinely fits none of the categories, still assign the closest one but give it a low confidence (below 0.4).
- If you see a coherent theme covering several tabs that no category covers, add it to "proposedCategories". Do not invent a category for a single stray tab. Return an empty array if nothing qualifies.`;
}

/**
 * Classify tabs in batches. `onProgress({done, total})` fires per batch.
 * Returns { assignments, proposedCategories, usage, batches }.
 */
export async function classifyTabs({
  apiKey,
  model = DEFAULT_MODEL,
  tabs,
  categories,
  onProgress = () => {}
}) {
  const system = classifySystem(categories);
  const validNames = new Set(categories.map((c) => c.name));

  const assignments = [];
  const proposed = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let batches = 0;

  for (let start = 0; start < tabs.length; start += BATCH_SIZE) {
    const slice = tabs.slice(start, start + BATCH_SIZE);
    const lines = slice.map((t, i) => `${i}\t${t.title ?? ''}\t${t.url ?? ''}`).join('\n');
    const userText =
      `Classify these ${slice.length} tabs. Format is "index<TAB>title<TAB>url".\n` +
      `Return one assignment per tab, using the index shown.\n\n${lines}`;

    const { parsed, usage: u } = await callClaude({
      apiKey,
      model,
      system,
      userText,
      schema: CLASSIFY_SCHEMA
    });

    for (const a of parsed.assignments) {
      const tab = slice[a.i];
      if (!tab) continue; // model returned an index we didn't send
      // Never trust a returned category that isn't in the taxonomy — that is
      // precisely the drift the persisted taxonomy exists to prevent.
      if (!validNames.has(a.category)) continue;
      assignments.push({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        category: a.category,
        group: String(a.group ?? '').trim() || 'general',
        confidence: typeof a.confidence === 'number' ? a.confidence : 0.5
      });
    }

    for (const p of parsed.proposedCategories ?? []) {
      if (!proposed.some((x) => x.name.toLowerCase() === String(p.name).toLowerCase())) proposed.push(p);
    }

    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    batches += 1;

    onProgress({ done: Math.min(start + BATCH_SIZE, tabs.length), total: tabs.length });
  }

  return { assignments, proposedCategories: proposed, usage, batches };
}

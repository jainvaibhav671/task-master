import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { HttpError } from '../utils/errors.js';

let client;
const getClient = () => {
  // The SDK resolves ANTHROPIC_API_KEY (or another configured credential).
  client ??= new Anthropic();
  return client;
};

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SYSTEM = `You help people write clear tasks for a team task tracker.
Write in plain, direct language. Do not invent facts, names, dates or numbers
that are not in the input. Reply with the requested text only: no preamble,
no headings, no surrounding quotes.`;

const run = async (prompt) => {
  if (!aiEnabled()) {
    throw new HttpError(503, 'AI features are not configured. Set ANTHROPIC_API_KEY to enable them.');
  }
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      // Server-side fallback reruns the request on another model if this one declines.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'AI service is busy, try again shortly');
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'AI service credentials are invalid');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, 'AI service request failed');
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, 'The AI model declined to generate text for this input');
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new HttpError(502, 'AI service returned an empty response');
  return text;
};

export const generateDescription = ({ title, notes }) =>
  run(
    `Write a task description for this task. Include a one-sentence goal and,
when the input supports it, a short bulleted list of acceptance criteria.
Keep it under 150 words.

Title: ${title}
${notes ? `Notes from the user: ${notes}` : ''}`,
  );

export const summarizeTask = (task, comments) =>
  run(
    `Summarize the current state of this task in 2 to 4 sentences: what it is,
where it stands, and any open questions or blockers raised in the comments.

Title: ${task.title}
Status: ${task.status}
Priority: ${task.priority}
Due: ${task.dueDate ? task.dueDate.toISOString().slice(0, 10) : 'none'}
Description: ${task.description ?? '(none)'}

Comments (oldest first):
${comments.length ? comments.map((c) => `- ${c.author.name}: ${c.body}`).join('\n') : '(none)'}`,
  );

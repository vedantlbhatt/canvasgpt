import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildCanvasTools, CANVAS_TOOL_NAMES } from './tools.js';
import { getMeta } from './db.js';

const TZ = process.env.USER_TZ || 'America/New_York';

function systemPrompt(db) {
  const now = new Date();
  const localNow = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, dateStyle: 'full', timeStyle: 'short',
  }).format(now);
  const name = getMeta(db, 'user_name') || 'the student';
  const lastSync = getMeta(db, 'last_sync_at');
  const courses = db.prepare(
    `SELECT course_code, name FROM courses WHERE workflow_state='available' ORDER BY name`,
  ).all();

  return `You are CanvasGPT, a private assistant over ${name}'s Georgia Tech Canvas data.

RIGHT NOW: ${localNow} (${TZ}). In UTC: ${now.toISOString()}.
Canvas data last synced: ${lastSync || 'unknown'}.

All timestamps in the database are UTC. The user lives in ${TZ}. Canvas due
times of 03:59Z or 04:59Z are the classic "11:59 PM local" deadline — always
convert before you state a time, and say the local time, not the UTC one.

You answer only from the canvas tools. You have no filesystem, shell, or web
access, and no knowledge of these courses beyond what the tools return. If a
tool returns nothing, say so plainly instead of guessing. Never invent an
assignment, a due date, a grade, or a URL.

Cite the Canvas URL (the "url" field) for anything specific you report, as a
markdown link on the item's name.

Enrolled courses (${courses.length}):
${courses.map((c) => `- ${c.course_code || '—'}: ${c.name}`).join('\n')}

Style: direct and short. Lead with the answer. Use a compact markdown list for
multiple items with the due date and course on each line. No preamble, no
"I found that", no restating the question. When something is overdue or
missing, say so first.`;
}

/**
 * Run one turn. Yields {type:'text',text} deltas, {type:'tool',name,input},
 * and finally {type:'done', sessionId, cost}.
 */
export async function* runTurn(db, { prompt, resumeSessionId }) {
  const canvas = buildCanvasTools(db);

  const q = query({
    prompt,
    options: {
      systemPrompt: systemPrompt(db),
      // No built-in tools at all: no Bash, no Read, no WebFetch.
      tools: [],
      mcpServers: { canvas },
      allowedTools: CANVAS_TOOL_NAMES,
      // Never load the user's CLAUDE.md / settings into this agent.
      settingSources: [],
      includePartialMessages: true,
      maxTurns: 24,
      // 'default' keeps canUseTool authoritative; 'bypassPermissions' would shadow it.
      permissionMode: 'default',
      ...(process.env.MODEL ? { model: process.env.MODEL } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      canUseTool: async (name) =>
        CANVAS_TOOL_NAMES.includes(name)
          ? { behavior: 'allow', updatedInput: undefined }
          : { behavior: 'deny', message: 'CanvasGPT may only use its Canvas query tools.' },
      stderr: (d) => process.env.DEBUG_SDK && console.error('[sdk]', d),
    },
  });

  let sessionId = resumeSessionId || null;
  try {
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        sessionId = msg.session_id || sessionId;
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          yield { type: 'text', text: ev.delta.text };
        }
      } else if (msg.type === 'assistant') {
        sessionId = msg.session_id || sessionId;
        for (const block of msg.message?.content || []) {
          if (block.type === 'tool_use') {
            yield { type: 'tool', name: String(block.name).replace('mcp__canvas__', ''), input: block.input };
          }
        }
      } else if (msg.type === 'result') {
        sessionId = msg.session_id || sessionId;
        if (msg.subtype !== 'success') {
          yield { type: 'error', message: msg.subtype === 'error_max_turns' ? 'Hit the turn limit.' : (msg.result || 'The model run failed.') };
        }
        yield { type: 'done', sessionId, cost: msg.total_cost_usd ?? null, turns: msg.num_turns };
      }
    }
  } finally {
    q.close?.();
  }
}

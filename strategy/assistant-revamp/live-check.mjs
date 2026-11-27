// Live check of the Assistant against a local website, driven the way the
// editor drives it: a static system prompt, the editor context as the last
// user message, tool rounds, and providerPin echoed back from each done event.
// Spends real OpenRouter money (well under a cent per run).
//
//   1. Start the website from a shell, not from the browser pane's launcher
//      (that launcher blocks outbound network): cd website && npm run dev:serve
//   2. website/.dev.vars must set OPENROUTER_API_KEY.
//   3. node editor/strategy/assistant-revamp/live-check.mjs
//
// Then read the assistant_step log lines in the server output and the
// ai_route_speed table in the local D1.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = "https://localhost:8788";
const rules = Array.from({ length: 60 }, (_, i) =>
  `Rule ${i + 1}: When working on glyph data, keep station names, drawing ids and anchor names exactly as the font defines them, and report what you changed in one short sentence.`).join("\n");
const SYSTEM = `You are the Counterpunch font editor assistant. Use the tools to answer.\n${rules}`;
const TOOLS = [
  { type: "function", function: { name: "glyph_count", description: "Number of glyphs in the font.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "glyph_name", description: "Name of the glyph at an index.", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } } },
];
const GLYPHS = ["space", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
function runTool(name, args) {
  if (name === "glyph_count") return String(GLYPHS.length);
  if (name === "glyph_name") return GLYPHS[args.index] ?? "none";
  return "unknown tool";
}
const session = await (await fetch(`${BASE}/api/dev/local-cloud-session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://localhost:8000" }, body: "{}" })).json();
const auth = { Authorization: `Bearer ${session.sessionToken}` };

async function round(chat, runId) {
  const context = { role: "user", content: `[Editor context, not a user request]\nCURRENT PROMPT PERMISSION: read only\nCURRENT EDITOR STATE: {"caret":${Math.floor(Math.random() * 100)}}` };
  const body = { messages: [...chat.messages, context], tools: TOOLS, systemPrompt: SYSTEM, stream: true, billingRunId: runId, ...(chat.pin ? { providerPin: chat.pin } : {}) };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/ai/assistant`, { method: "POST", headers: { "Content-Type": "application/json", ...auth, Origin: "https://localhost:8000" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  let buf = "", text = "", toolCalls = null, done = null, errors = [];
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of ev.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const d = JSON.parse(line.slice(6));
        if (d.type === "chunk") text += d.content ?? "";
        else if (d.type === "tool_call") toolCalls = d.tool_calls;
        else if (d.type === "done") done = d;
        else if (d.type === "error") errors.push(d);
      }
    }
  }
  return { text, toolCalls, done, errors, ms: Date.now() - t0 };
}

async function prompt(chat, userText, label) {
  chat.messages.push({ role: "user", content: userText });
  const runId = `live-${label}-${Date.now()}`;
  for (let r = 0; r < 6; r++) {
    const out = await round(chat, runId);
    const u = out.done?.usage || {};
    if (out.done?.providerPin) chat.pin = out.done.providerPin;
    console.log(JSON.stringify({ label, round: r, ms: out.ms, pin: chat.pin, served: out.done?.served, prompt_tokens: u.prompt_tokens, cached: u.cached_tokens, errors: out.errors.length ? out.errors : undefined, tools: out.toolCalls?.map((c) => c.function?.name) }));
    if (out.toolCalls?.length) {
      chat.messages.push({ role: "assistant", content: out.text || null, tool_calls: out.toolCalls });
      for (const c of out.toolCalls) chat.messages.push({ role: "tool", tool_call_id: c.id, content: runTool(c.function.name, JSON.parse(c.function.arguments || "{}")) });
      continue;
    }
    chat.messages.push({ role: "assistant", content: out.text });
    console.log(`  reply: ${out.text.slice(0, 160).replace(/\n/g, " ")}`);
    return;
  }
}

const A = { messages: [], pin: null };
await prompt(A, "Use the tools: first get the glyph count, then the names of glyphs 3 and 7, one tool call at a time. Then tell me all three answers.", "A1");
await prompt(A, "Now get the name of glyph 10 with the tool and tell me.", "A2");
const B = { messages: [], pin: null };
await prompt(B, "Use the tool to get the glyph count and tell me.", "B1");

/**
 * Real-world cost and quality comparison of AI models on the tour's filter
 * step: Fustat is open, the filter editor gets the tour's description, and
 * Update filter asks the Assistant to write the filter.
 *
 * The page's /api/ai/assistant requests go straight to OpenRouter with the
 * development key and the model under test, shaped like the website proxy's
 * requests. DeepSeek models get their endpoints from the Assistant's own
 * routing (website/plugins-worker/review/ai-route.mjs, profile "assistant"):
 * a gate on the endpoint list, then a live probe that ranks the endpoints by
 * measured correctness, cost and speed.
 *
 * Spends real money, so it runs only on request:
 *   AI_COST_E2E=1 npx playwright test --project=ai-cost
 * AI_COST_MODELS (comma-separated keys of MODELS) and AI_COST_RUNS (default
 * 5) narrow a run. AI_COST_EDITOR_URL points at another editor server, such
 * as a production build served with http-server: the webpack dev server
 * loses lazy chunks after a rebuild. Results go to
 * test-results/ai-filter-cost.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Page, type Route } from '@playwright/test';
import { test, expect } from './fixtures';
import {
    openMemoryFont,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

const WORKSPACE = path.resolve(__dirname, '../../..');
const WEBSITE_URL = 'https://localhost:8788';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
// Same as the website proxy (functions/api/ai/assistant.js).
const MAX_TOKENS = 8192;
const RUNS = Number(process.env.AI_COST_RUNS || 5);
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

type ProviderPrefs = Record<string, unknown>;

type ModelSpec = {
    label: string;
    model: string;
    /** As in website/utils/ai-settings.js, where the model is configured. */
    reasoningEffort?: string;
    /** Pick endpoints with the Assistant's routing. */
    reviewRouting?: boolean;
};

const MODELS: Record<string, ModelSpec> = {
    'luna': {
        label: 'GPT Luna Latest',
        model: '~openai/gpt-luna-latest',
        reasoningEffort: 'high'
    },
    'terra': { label: 'GPT Terra Latest', model: '~openai/gpt-terra-latest' },
    'haiku': {
        label: 'Haiku Latest',
        model: '~anthropic/claude-haiku-latest'
    },
    'sonnet': {
        label: 'Sonnet Latest',
        model: '~anthropic/claude-sonnet-latest'
    },
    'deepseek-flash': {
        label: 'DeepSeek Flash Latest',
        model: '~deepseek/deepseek-flash-latest',
        reviewRouting: true
    },
    'deepseek-pro': {
        label: 'DeepSeek Pro Latest',
        model: '~deepseek/deepseek-pro-latest',
        reviewRouting: true
    }
};

/** Tool calls a clean run needs: write, validate, test, name. */
const MINIMUM_TOOL_CALLS = 4;
/** The code and the filter guide are in the system prompt already. */
const NEEDLESS_TOOLS = new Set([
    'get_active_python_document',
    'handbook_toc',
    'handbook_topic'
]);
/** Tools that edit the filter document. */
const EDIT_TOOLS = new Set([
    'replace_python_document_in_editor',
    'replace_python_text_in_editor'
]);
/** Tools whose answer only changes after an edit. */
const CHECK_TOOLS = new Set([
    'validate_python_document',
    'test_filter_on_font'
]);

type ToolCall = { name: string; args: string; failed: boolean };

type Request = {
    servedModel: string;
    provider: string;
    cost: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    ms: number;
    error?: string;
};

type Grade = {
    correct: boolean;
    found: number;
    expected: number;
    missing: number;
    extra: number;
    groups: number;
    problems: string[];
};

type RunResult = {
    run: number;
    reason: string;
    seconds: number;
    cost: number;
    requests: Request[];
    toolCalls: ToolCall[];
    needlessToolCalls: string[];
    failedToolCalls: number;
    grade: Grade;
    reply: string;
};

function openRouterKey(): string {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    const devVars = path.join(WORKSPACE, 'website/.dev.vars');
    const line = fs
        .readFileSync(devVars, 'utf8')
        .split('\n')
        .find((entry) => /^OPENROUTER_API_KEY\s*=/.test(entry));
    const key = line
        ?.slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    if (!key) throw new Error(`OPENROUTER_API_KEY is missing in ${devVars}`);
    return key;
}

/** The tour's description, read from the source so the two never drift. */
function tourFilterDescription(): string {
    const source = fs.readFileSync(
        path.resolve(__dirname, '../js/tour-ai.ts'),
        'utf8'
    );
    const match = /TOUR_FILTER_DESCRIPTION =\s*'([^']+)'/.exec(source);
    if (!match) throw new Error('TOUR_FILTER_DESCRIPTION not found');
    return match[1];
}

type ReviewRoute = {
    model: string;
    providers: string[];
    provider: ProviderPrefs;
    warnings: string[];
};

async function reviewRoute(
    alias: string,
    apiKey: string
): Promise<ReviewRoute> {
    const module = (await import(
        pathToFileURL(
            path.join(WORKSPACE, 'website/plugins-worker/review/ai-route.mjs')
        ).href
    )) as {
        chooseRoute(options: {
            profile: string;
            alias: string;
            apiKey: string;
        }): Promise<ReviewRoute>;
    };
    return module.chooseRoute({ profile: 'assistant', alias, apiKey });
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function cors(route: Route): Record<string, string> {
    return {
        ...CORS_HEADERS,
        'Access-Control-Allow-Origin':
            route.request().headers()['origin'] || '*'
    };
}

/**
 * One Assistant turn's traffic: every OpenRouter request it made, and the
 * conversation as the page sent it last.
 */
class TurnRecorder {
    requests: Request[] = [];
    lastMessages: Array<Record<string, unknown>> = [];
    finalReply: Record<string, unknown> | null = null;

    reset(): void {
        this.requests = [];
        this.lastMessages = [];
        this.finalReply = null;
    }
}

async function installWebsiteStub(
    page: Page,
    spec: ModelSpec,
    model: string,
    provider: ProviderPrefs | undefined,
    apiKey: string,
    recorder: TurnRecorder
): Promise<void> {
    await page.route(`${WEBSITE_URL}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: cors(route) });
            return;
        }
        if (url.pathname === '/api/auth/me') {
            await route.fulfill({
                status: 200,
                headers: { ...cors(route), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'ai-cost', email: 'ai-cost@example.com' },
                    subscription: { status: 'active', canUseAssistant: true },
                    capabilities: { canUseAssistant: true },
                    credits: { balanceCents: 1000 }
                })
            });
            return;
        }
        if (url.pathname === '/api/ai/assistant') {
            await proxyAssistant(
                route,
                spec,
                model,
                provider,
                apiKey,
                recorder
            );
            return;
        }
        await route.fulfill({ status: 204, headers: cors(route) });
    });
}

async function proxyAssistant(
    route: Route,
    spec: ModelSpec,
    model: string,
    provider: ProviderPrefs | undefined,
    apiKey: string,
    recorder: TurnRecorder
): Promise<void> {
    const payload = route.request().postDataJSON() as {
        messages: Array<Record<string, unknown>>;
        tools: unknown[];
        systemPrompt: string;
    };
    recorder.lastMessages = payload.messages;
    const body: Record<string, unknown> = {
        model,
        max_tokens: MAX_TOKENS,
        messages: [
            { role: 'system', content: payload.systemPrompt },
            ...payload.messages
        ],
        usage: { include: true }
    };
    if (spec.reasoningEffort) {
        body.reasoning = { effort: spec.reasoningEffort };
    }
    if (provider) body.provider = provider;
    if (payload.tools.length > 0) {
        body.tools = payload.tools;
        body.tool_choice = 'auto';
    }

    const started = Date.now();
    const response = await fetch(OPENROUTER, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://counterpunch.space',
            'X-Title': 'Counterpunch Assistant cost test'
        },
        body: JSON.stringify(body)
    });
    const json = (await response.json().catch(() => ({}))) as {
        id?: string;
        model?: string;
        provider?: string;
        error?: { message?: string };
        choices?: Array<{
            message?: {
                content?: string | null;
                tool_calls?: unknown[];
            };
        }>;
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            cost?: number;
            prompt_tokens_details?: { cached_tokens?: number };
        };
    };
    const usage = json.usage ?? {};
    const record: Request = {
        servedModel: json.model ?? '',
        provider: json.provider ?? '',
        cost: usage.cost ?? 0,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        ms: Date.now() - started
    };
    const message = json.choices?.[0]?.message;
    if (!response.ok || json.error || !message) {
        record.error =
            json.error?.message || `OpenRouter HTTP ${response.status}`;
        recorder.requests.push(record);
        await route.fulfill({
            status: response.ok ? 502 : response.status,
            headers: { ...cors(route), 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: record.error })
        });
        return;
    }
    recorder.requests.push(record);

    // Re-encode as the website proxy's event stream.
    const events: Array<Record<string, unknown>> = [];
    if (message.content) {
        events.push({
            type: 'chunk',
            content: message.content,
            generationId: json.id
        });
    }
    if (message.tool_calls?.length) {
        events.push({
            type: 'tool_call',
            tool_calls: message.tool_calls,
            generationId: json.id
        });
    } else {
        recorder.finalReply = {
            role: 'assistant',
            content: message.content ?? ''
        };
    }
    events.push({
        type: 'done',
        generationId: json.id,
        usage: {
            prompt_tokens: record.promptTokens,
            completion_tokens: record.completionTokens,
            total_tokens: record.promptTokens + record.completionTokens,
            cached_tokens: record.cachedTokens,
            total_cost: record.cost
        }
    });
    await route.fulfill({
        status: 200,
        headers: { ...cors(route), 'Content-Type': 'text/event-stream' },
        body: events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
    });
}

/** Tool calls from the conversation the page sent last, with their results. */
function toolCallsOf(messages: Array<Record<string, unknown>>): ToolCall[] {
    const results = new Map<string, string>();
    for (const message of messages) {
        if (message.role === 'tool') {
            results.set(
                String(message.tool_call_id),
                String(message.content ?? '')
            );
        }
    }
    const calls: ToolCall[] = [];
    for (const message of messages) {
        if (
            message.role !== 'assistant' ||
            !Array.isArray(message.tool_calls)
        ) {
            continue;
        }
        for (const raw of message.tool_calls as Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
        }>) {
            const result = results.get(String(raw.id)) ?? '';
            calls.push({
                name: raw.function?.name ?? '',
                args: raw.function?.arguments ?? '',
                failed: result.startsWith('Error:') || failedCheck(result)
            });
        }
    }
    return calls;
}

/** A validation or dry run that reported errors. */
function failedCheck(result: string): boolean {
    try {
        const parsed: unknown = JSON.parse(result);
        if (!parsed || typeof parsed !== 'object') return false;
        const record = parsed as {
            ok?: unknown;
            valid?: unknown;
            errors?: unknown;
        };
        return (
            record.ok === false ||
            record.valid === false ||
            (Array.isArray(record.errors) && record.errors.length > 0)
        );
    } catch {
        return false;
    }
}

/**
 * Calls a clean run would not make: lookups of what the prompt already
 * holds, a check repeated with no edit in between, a second rename.
 */
function needlessCalls(calls: ToolCall[]): string[] {
    const needless: string[] = [];
    const checkedSinceEdit = new Set<string>();
    const seen = new Set<string>();
    let named = false;
    for (const call of calls) {
        const key = `${call.name}(${call.args})`;
        if (EDIT_TOOLS.has(call.name)) {
            checkedSinceEdit.clear();
        } else if (NEEDLESS_TOOLS.has(call.name)) {
            needless.push(call.name);
        } else if (CHECK_TOOLS.has(call.name)) {
            if (checkedSinceEdit.has(call.name))
                needless.push(`repeat ${call.name}`);
            checkedSinceEdit.add(call.name);
        } else if (call.name === 'name_filter') {
            if (named) needless.push('rename');
            named = true;
        } else if (seen.has(key)) {
            needless.push(`repeat ${call.name}`);
        }
        seen.add(key);
    }
    return needless;
}

/**
 * Dry-run the filter as it stands and compare with the font: every glyph of
 * a stylistic set (named *.ssNN*), nothing else, one group per set, each in
 * its own color.
 */
async function gradeFilter(page: Page): Promise<Grade> {
    return page.evaluate(async () => {
        const win = window as any;
        const editorElement = document.querySelector('.gfe [data-ref="ace"]');
        const code: string = editorElement
            ? win.ace.edit(editorElement).getValue()
            : '';
        const glyphs: Array<{ name: string }> =
            win.currentFontModel?.glyphs ?? [];
        const expected = new Map<string, string>();
        for (const glyph of glyphs) {
            const set = /\.(ss\d\d)(\.|$)/.exec(glyph.name)?.[1];
            if (set) expected.set(glyph.name, set);
        }
        const preview =
            await win.glyphOverviewFilterManager.previewFilter(code);
        const problems: string[] = preview.errors.map(
            (error: { message: string }) => error.message
        );
        const found = new Set<string>(preview.glyphNames);
        const missing = [...expected.keys()].filter((name) => !found.has(name));
        const extra = [...found].filter((name) => !expected.has(name));
        if (missing.length)
            problems.push(`missing ${missing.slice(0, 5).join(', ')}`);
        if (extra.length)
            problems.push(`extra ${extra.slice(0, 5).join(', ')}`);

        // Each set must land in exactly one group of its own.
        const groupsOfSet = new Map<string, Set<string>>();
        const setsOfGroup = new Map<string, Set<string>>();
        const colorOfGroup = new Map<string, string>();
        for (const result of preview.results as Array<{
            glyph_name: string;
            group?: string;
            groups?: string[];
            color?: string;
            colors?: string[];
        }>) {
            const set = expected.get(result.glyph_name);
            if (!set) continue;
            const groups =
                result.groups ?? (result.group ? [result.group] : []);
            const key = groups.slice().sort().join('+') || '(none)';
            if (!groupsOfSet.has(set)) groupsOfSet.set(set, new Set());
            groupsOfSet.get(set)!.add(key);
            if (!setsOfGroup.has(key)) setsOfGroup.set(key, new Set());
            setsOfGroup.get(key)!.add(set);
            colorOfGroup.set(
                key,
                (result.colors ?? [result.color ?? '']).join('+')
            );
        }
        for (const [set, groups] of groupsOfSet) {
            if (groups.size !== 1)
                problems.push(`${set} is split over ${groups.size} groups`);
            if (groups.has('(none)')) problems.push(`${set} has no group`);
        }
        for (const [group, sets] of setsOfGroup) {
            if (sets.size > 1)
                problems.push(`group ${group} mixes ${[...sets].join(', ')}`);
        }
        const colors = [...colorOfGroup.values()];
        if (new Set(colors).size !== colors.length) {
            problems.push('groups share a color');
        }
        if (colors.some((color) => !color))
            problems.push('a group has no color');
        return {
            correct: preview.ok && problems.length === 0,
            found: found.size,
            expected: expected.size,
            missing: missing.length,
            extra: extra.length,
            groups: preview.groups.length,
            problems
        };
    });
}

async function openFilterEditor(
    page: Page,
    description: string
): Promise<void> {
    await page.locator('#overview-filters .glyph-filter-new-btn').click();
    const desc = page.locator('.gfe [data-ref="desc"]');
    await expect(desc).toBeVisible({ timeout: 30000 });
    await desc.fill(description);
}

async function closeFilterEditor(page: Page): Promise<void> {
    await page.locator('.gfe [data-ref="close"]').click();
    const discard = page.getByRole('button', { name: 'Discard' });
    if (await discard.isVisible({ timeout: 2000 }).catch(() => false)) {
        await discard.click();
    }
    await expect(page.locator('.gfe')).toHaveCount(0, { timeout: 10000 });
}

async function runOnce(
    page: Page,
    run: number,
    description: string,
    recorder: TurnRecorder
): Promise<RunResult> {
    recorder.reset();
    await openFilterEditor(page, description);
    const turnFinished = page.evaluate(
        (timeout) =>
            new Promise<string>((resolve) => {
                const timer = setTimeout(() => resolve('timeout'), timeout);
                window.addEventListener(
                    'glyphFilterTurnFinished',
                    (event) => {
                        clearTimeout(timer);
                        resolve(
                            String((event as CustomEvent).detail?.reason ?? '')
                        );
                    },
                    { once: true }
                );
            }),
        TURN_TIMEOUT_MS
    );
    const started = Date.now();
    await page.locator('.gfe [data-ref="update"]').click();
    const reason = await turnFinished;
    const seconds = (Date.now() - started) / 1000;
    // Let the editor apply the last edit before grading.
    await page.waitForTimeout(500);
    const grade = await gradeFilter(page);
    const messages = recorder.finalReply
        ? [...recorder.lastMessages, recorder.finalReply]
        : recorder.lastMessages;
    const toolCalls = toolCallsOf(messages);
    await closeFilterEditor(page);
    return {
        run,
        reason,
        seconds,
        cost: recorder.requests.reduce((sum, request) => sum + request.cost, 0),
        requests: recorder.requests,
        toolCalls,
        needlessToolCalls: needlessCalls(toolCalls),
        failedToolCalls: toolCalls.filter((call) => call.failed).length,
        grade: { ...grade, correct: grade.correct && reason === 'done' },
        reply: String(recorder.finalReply?.content ?? '')
    };
}

type ModelReport = {
    key: string;
    label: string;
    model: string;
    providers: string[];
    routeWarnings: string[];
    runs: RunResult[];
};

const REPORT_PATH = path.resolve(
    __dirname,
    '../test-results/ai-filter-cost.json'
);

function saveReport(report: ModelReport): void {
    const all: Record<string, ModelReport> = fs.existsSync(REPORT_PATH)
        ? JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
        : {};
    all[report.key] = report;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(all, null, 2)}\n`);
}

function average(values: number[]): number {
    return values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
}

function summarize(report: ModelReport): string {
    const runs = report.runs;
    const served = [
        ...new Set(
            runs.flatMap((run) => run.requests.map((r) => r.servedModel))
        )
    ];
    const providers = [
        ...new Set(runs.flatMap((run) => run.requests.map((r) => r.provider)))
    ];
    return [
        `${report.label} (${served.join(', ') || report.model}) via ${providers.join(', ') || '?'}`,
        `  avg cost $${average(runs.map((run) => run.cost)).toFixed(4)}, avg ${average(runs.map((run) => run.seconds)).toFixed(0)} s`,
        `  correct ${runs.filter((run) => run.grade.correct).length}/${runs.length}`,
        `  avg tool calls ${average(runs.map((run) => run.toolCalls.length)).toFixed(1)} (minimum ${MINIMUM_TOOL_CALLS}), needless ${average(runs.map((run) => run.needlessToolCalls.length)).toFixed(1)}, failed ${average(runs.map((run) => run.failedToolCalls)).toFixed(1)}`,
        ...runs.map(
            (run) =>
                `  #${run.run}: ${run.reason}, $${run.cost.toFixed(4)}, ${run.seconds.toFixed(0)} s, ${run.toolCalls.map((call) => call.name + (call.failed ? '!' : '')).join(' → ')}` +
                (run.grade.problems.length
                    ? ` | ${run.grade.problems.join('; ')}`
                    : '')
        )
    ].join('\n');
}

const selected = (process.env.AI_COST_MODELS || Object.keys(MODELS).join(','))
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

test.describe('AI filter step cost', () => {
    for (const key of selected) {
        test(key, async ({ page }) => {
            const spec = MODELS[key];
            if (!spec) throw new Error(`Unknown model key ${key}`);
            test.setTimeout(RUNS * TURN_TIMEOUT_MS + 10 * 60 * 1000);
            const apiKey = openRouterKey();
            const description = tourFilterDescription();

            let model = spec.model;
            let provider: ProviderPrefs | undefined;
            let providers: string[] = [];
            let routeWarnings: string[] = [];
            if (spec.reviewRouting) {
                const route = await reviewRoute(spec.model, apiKey);
                model = route.model;
                provider = route.provider;
                providers = route.providers;
                routeWarnings = route.warnings;
                console.log(
                    `[ai-cost] ${spec.label}: ${model} via ${providers.join(', ') || '(no providers)'}${routeWarnings.length ? ` — ${routeWarnings.join('; ')}` : ''}`
                );
            }

            const recorder = new TurnRecorder();
            await installWebsiteStub(
                page,
                spec,
                model,
                provider,
                apiKey,
                recorder
            );
            page.on('dialog', (dialog) => {
                console.log(`[ai-cost] page dialog: ${dialog.message()}`);
                void dialog.dismiss();
            });
            await page.goto(
                `${process.env.AI_COST_EDITOR_URL ?? ''}/?test=true`
            );
            await waitForCanvasReady(page);
            await openMemoryFont(page, 'Fustat.glyphs');
            await waitForOpenSessionReady(page, 'Fustat.glyphs');
            await page.waitForFunction(
                () =>
                    (window as any).authManager?.subscription
                        ?.canUseAssistant === true,
                undefined,
                { timeout: 60000 }
            );
            await expect(
                page.locator('#overview-filters .glyph-filter-new-btn')
            ).toBeVisible({ timeout: 60000 });

            const report: ModelReport = {
                key,
                label: spec.label,
                model,
                providers,
                routeWarnings,
                runs: []
            };
            for (let run = 1; run <= RUNS; run++) {
                const result = await runOnce(page, run, description, recorder);
                report.runs.push(result);
                saveReport(report);
                console.log(
                    `[ai-cost] ${spec.label} #${run}: ${result.reason}, $${result.cost.toFixed(4)}, correct=${result.grade.correct}`
                );
            }
            console.log(`[ai-cost]\n${summarize(report)}`);
        });
    }
});

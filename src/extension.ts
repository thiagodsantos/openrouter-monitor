import * as vscode from 'vscode';

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SECRET_API_KEY = 'openrouterMonitor.apiKey';
const STATE_TOKEN_STATS = 'openrouterMonitor.tokenStats';

interface KeyInfo {
  label: string;
  limit: number | null;
  limit_reset: string | null;
  limit_remaining: number | null;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  is_free_tier: boolean;
}

interface CreditsInfo {
  total_credits: number;
  total_usage: number;
}

interface TokenStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

let creditsStatusBarItem: vscode.StatusBarItem;
let tokensStatusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

let lastKeyInfo: KeyInfo | undefined;
let lastCreditsInfo: CreditsInfo | undefined;
let lastError: string | undefined;
let lastUpdated: Date | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('OpenRouter Monitor');

  creditsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  creditsStatusBarItem.command = 'openrouterMonitor.showDetails';
  creditsStatusBarItem.text = '$(credit-card) OpenRouter: click to set up';
  creditsStatusBarItem.show();
  context.subscriptions.push(creditsStatusBarItem);

  tokensStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  tokensStatusBarItem.command = 'openrouterMonitor.showDetails';
  tokensStatusBarItem.show();
  context.subscriptions.push(tokensStatusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterMonitor.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('openrouterMonitor.refresh', () => refreshUsage(context, true)),
    vscode.commands.registerCommand('openrouterMonitor.showDetails', () => showDetails(context)),
    vscode.commands.registerCommand('openrouterMonitor.askModel', () => askModel(context)),
    vscode.commands.registerCommand('openrouterMonitor.resetTokenStats', () => resetTokenStats(context))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openrouterMonitor.refreshIntervalMinutes')) {
        setupAutoRefresh(context);
      }
    })
  );

  updateTokensStatusBar(context);
  setupAutoRefresh(context);
  void refreshUsage(context, false);
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

// ---------- API key handling ----------

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_API_KEY);
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your OpenRouter API key (from https://openrouter.ai/keys)',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-or-v1-...'
  });
  if (!key) {
    return;
  }
  await context.secrets.store(SECRET_API_KEY, key.trim());
  vscode.window.showInformationMessage('OpenRouter API key saved.');
  await refreshUsage(context, true);
}

// ---------- Auto refresh ----------

function setupAutoRefresh(context: vscode.ExtensionContext): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  const cfg = vscode.workspace.getConfiguration('openrouterMonitor');
  const minutes = cfg.get<number>('refreshIntervalMinutes', 5);
  if (minutes > 0) {
    refreshTimer = setInterval(() => void refreshUsage(context, false), minutes * 60 * 1000);
  }
}

// ---------- Credits fetching ----------

async function refreshUsage(context: vscode.ExtensionContext, showErrors: boolean): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    creditsStatusBarItem.text = '$(credit-card) OpenRouter: set API key';
    creditsStatusBarItem.tooltip = 'Click to set your OpenRouter API key';
    return;
  }

  creditsStatusBarItem.text = '$(sync~spin) OpenRouter...';

  try {
    const keyRes = await fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!keyRes.ok) {
      throw new Error(`HTTP ${keyRes.status}: ${await safeText(keyRes)}`);
    }
    const keyJson = (await keyRes.json()) as { data: KeyInfo };
    lastKeyInfo = keyJson.data;
    lastError = undefined;
    lastUpdated = new Date();

    // Best-effort: account-wide balance. Some accounts / key types may not
    // have access to this endpoint, so failures here are non-fatal.
    try {
      const creditsRes = await fetch(OPENROUTER_CREDITS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (creditsRes.ok) {
        const creditsJson = (await creditsRes.json()) as { data: CreditsInfo };
        lastCreditsInfo = creditsJson.data;
      } else {
        lastCreditsInfo = undefined;
      }
    } catch {
      lastCreditsInfo = undefined;
    }

    renderCreditsStatusBar();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    creditsStatusBarItem.text = '$(error) OpenRouter: error';
    creditsStatusBarItem.tooltip = `Failed to fetch OpenRouter usage: ${lastError}\nClick for details.`;
    outputChannel.appendLine(`[refreshUsage] ${lastError}`);
    if (showErrors) {
      vscode.window.showErrorMessage(`OpenRouter Monitor: ${lastError}`);
    }
  }
}

function renderCreditsStatusBar(): void {
  if (!lastKeyInfo) {
    return;
  }

  const used = lastCreditsInfo ? lastCreditsInfo.total_usage : lastKeyInfo.usage;

  let remainingText: string;
  if (lastCreditsInfo) {
    const remaining = lastCreditsInfo.total_credits - lastCreditsInfo.total_usage;
    remainingText = `$${remaining.toFixed(2)} left`;
  } else if (lastKeyInfo.limit_remaining !== null) {
    remainingText = `$${lastKeyInfo.limit_remaining.toFixed(2)} left`;
  } else {
    remainingText = 'no cap set';
  }

  creditsStatusBarItem.text = `$(credit-card) $${used.toFixed(2)} used \u00b7 ${remainingText}`;
  creditsStatusBarItem.tooltip = buildCreditsTooltip();
}

function buildCreditsTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown('**OpenRouter Usage**\n\n');

  if (lastKeyInfo) {
    md.appendMarkdown(`- Key label: ${lastKeyInfo.label ?? 'n/a'}\n`);
    md.appendMarkdown(`- Used (all time): $${lastKeyInfo.usage.toFixed(4)}\n`);
    md.appendMarkdown(`- Used today: $${lastKeyInfo.usage_daily.toFixed(4)}\n`);
    md.appendMarkdown(`- Used this week: $${lastKeyInfo.usage_weekly.toFixed(4)}\n`);
    md.appendMarkdown(`- Used this month: $${lastKeyInfo.usage_monthly.toFixed(4)}\n`);
    md.appendMarkdown(`- Per-key limit: ${lastKeyInfo.limit !== null ? `$${lastKeyInfo.limit.toFixed(2)}` : 'none'}\n`);
    md.appendMarkdown(
      `- Per-key remaining: ${lastKeyInfo.limit_remaining !== null ? `$${lastKeyInfo.limit_remaining.toFixed(2)}` : 'unlimited'}\n`
    );
  }

  if (lastCreditsInfo) {
    const remaining = lastCreditsInfo.total_credits - lastCreditsInfo.total_usage;
    md.appendMarkdown('\n**Account balance**\n\n');
    md.appendMarkdown(`- Total purchased: $${lastCreditsInfo.total_credits.toFixed(2)}\n`);
    md.appendMarkdown(`- Total used: $${lastCreditsInfo.total_usage.toFixed(2)}\n`);
    md.appendMarkdown(`- Remaining: $${remaining.toFixed(2)}\n`);
  }

  if (lastUpdated) {
    md.appendMarkdown(`\n_Last updated: ${lastUpdated.toLocaleTimeString()}_\n`);
  }

  md.appendMarkdown('\nClick for full details.');
  return md;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ---------- Local token tracking ----------
//
// OpenRouter's account-level API does not expose a running total of tokens
// consumed (only USD credit usage). To satisfy "show tokens used" this
// extension tracks token usage locally for requests made through its own
// "OpenRouter: Ask Model" command, where the API's `usage` field on each
// chat completion response is captured and accumulated.

function getTokenStats(context: vscode.ExtensionContext): TokenStats {
  return (
    context.globalState.get<TokenStats>(STATE_TOKEN_STATS) ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestCount: 0
    }
  );
}

async function addTokenUsage(
  context: vscode.ExtensionContext,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
): Promise<void> {
  const stats = getTokenStats(context);
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  stats.promptTokens += promptTokens;
  stats.completionTokens += completionTokens;
  stats.totalTokens += usage.total_tokens ?? promptTokens + completionTokens;
  stats.requestCount += 1;
  await context.globalState.update(STATE_TOKEN_STATS, stats);
  updateTokensStatusBar(context);
}

function updateTokensStatusBar(context: vscode.ExtensionContext): void {
  const stats = getTokenStats(context);
  tokensStatusBarItem.text = `$(pulse) ${formatNumber(stats.totalTokens)} tokens`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown("**Tokens used (via this extension's requests)**\n\n");
  md.appendMarkdown(`- Prompt tokens: ${formatNumber(stats.promptTokens)}\n`);
  md.appendMarkdown(`- Completion tokens: ${formatNumber(stats.completionTokens)}\n`);
  md.appendMarkdown(`- Total tokens: ${formatNumber(stats.totalTokens)}\n`);
  md.appendMarkdown(`- Requests made: ${stats.requestCount}\n\n`);
  md.appendMarkdown(
    "_OpenRouter's account API only reports USD usage, not a token counter, so this total reflects requests sent via \"OpenRouter: Ask Model\" in this extension._\n\n"
  );
  md.appendMarkdown('Click for full details.');
  tokensStatusBarItem.tooltip = md;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

async function resetTokenStats(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Reset locally-tracked token usage stats? This does not affect your OpenRouter account.',
    { modal: true },
    'Reset'
  );
  if (confirm === 'Reset') {
    await context.globalState.update(STATE_TOKEN_STATS, undefined);
    updateTokensStatusBar(context);
    vscode.window.showInformationMessage('Token stats reset.');
  }
}

// ---------- Ask model (also used to demonstrate/track token usage) ----------

async function askModel(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      'Set your OpenRouter API key first.',
      'Set API Key'
    );
    if (choice) {
      await setApiKey(context);
    }
    return;
  }

  const cfg = vscode.workspace.getConfiguration('openrouterMonitor');
  const defaultModel = cfg.get<string>('defaultModel', 'openai/gpt-4o-mini');

  const model = await vscode.window.showInputBox({
    prompt: 'Model to use (OpenRouter model slug)',
    value: defaultModel,
    ignoreFocusOut: true
  });
  if (!model) {
    return;
  }

  const prompt = await vscode.window.showInputBox({
    prompt: 'Prompt to send to OpenRouter',
    ignoreFocusOut: true
  });
  if (!prompt) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Asking ${model}...` },
    async () => {
      try {
        const res = await fetch(OPENROUTER_CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://marketplace.visualstudio.com/',
            'X-Title': 'VS Code OpenRouter Monitor'
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
        }

        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };

        const content = data.choices?.[0]?.message?.content ?? '(no content returned)';

        if (data.usage) {
          await addTokenUsage(context, data.usage);
        }

        outputChannel.appendLine(`\n=== ${model} | ${new Date().toLocaleString()} ===`);
        outputChannel.appendLine(`Prompt: ${prompt}`);
        outputChannel.appendLine(`Response: ${content}`);
        if (data.usage) {
          outputChannel.appendLine(
            `Usage: ${data.usage.prompt_tokens ?? 0} prompt + ${data.usage.completion_tokens ?? 0} completion = ${
              data.usage.total_tokens ?? 0
            } total tokens`
          );
        }
        outputChannel.show(true);

        // Credit usage changed after this request, so refresh it too.
        void refreshUsage(context, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`OpenRouter request failed: ${message}`);
      }
    }
  );
}

// ---------- Details quick pick ----------

async function showDetails(context: vscode.ExtensionContext): Promise<void> {
  const items: vscode.QuickPickItem[] = [];

  if (lastError) {
    items.push({ label: '$(error) Last error', detail: lastError });
  }

  if (lastKeyInfo) {
    items.push({ label: '$(credit-card) Used (all time)', description: `$${lastKeyInfo.usage.toFixed(4)}` });
    items.push({
      label: 'Used today / week / month',
      description: `$${lastKeyInfo.usage_daily.toFixed(4)} / $${lastKeyInfo.usage_weekly.toFixed(
        4
      )} / $${lastKeyInfo.usage_monthly.toFixed(4)}`
    });
    items.push({
      label: 'Per-key limit',
      description: lastKeyInfo.limit !== null ? `$${lastKeyInfo.limit.toFixed(2)}` : 'none'
    });
    items.push({
      label: 'Per-key remaining',
      description: lastKeyInfo.limit_remaining !== null ? `$${lastKeyInfo.limit_remaining.toFixed(2)}` : 'unlimited'
    });
  } else {
    items.push({ label: '$(info) No usage data yet', description: 'Set your API key to get started' });
  }

  if (lastCreditsInfo) {
    const remaining = lastCreditsInfo.total_credits - lastCreditsInfo.total_usage;
    items.push({ label: '$(wallet) Account total purchased', description: `$${lastCreditsInfo.total_credits.toFixed(2)}` });
    items.push({ label: 'Account total used', description: `$${lastCreditsInfo.total_usage.toFixed(2)}` });
    items.push({ label: 'Account remaining', description: `$${remaining.toFixed(2)}` });
  }

  const stats = getTokenStats(context);
  items.push({
    label: '$(pulse) Tokens used (tracked locally)',
    description: `${formatNumber(stats.totalTokens)} total`,
    detail: `${formatNumber(stats.promptTokens)} prompt + ${formatNumber(stats.completionTokens)} completion over ${stats.requestCount} request(s)`
  });

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(refresh) Refresh now' });
  items.push({ label: '$(comment-discussion) Ask a model (tracks tokens)' });
  items.push({ label: '$(key) Change API key' });
  items.push({ label: '$(trash) Reset local token stats' });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'OpenRouter Monitor',
    placeHolder: 'OpenRouter usage details'
  });

  if (!picked) {
    return;
  }
  if (picked.label.includes('Refresh now')) {
    await refreshUsage(context, true);
  } else if (picked.label.includes('Ask a model')) {
    await askModel(context);
  } else if (picked.label.includes('Change API key')) {
    await setApiKey(context);
  } else if (picked.label.includes('Reset local token stats')) {
    await resetTokenStats(context);
  }
}

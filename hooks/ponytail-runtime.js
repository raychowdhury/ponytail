const fs = require('fs');
const path = require('path');
const os = require('os');
const { getClaudeDir, getConfigDir, normalizePersistedMode } = require('./ponytail-config');

const STATE_FILE = '.ponytail-active';

// ponytail: VS Code Copilot never sets COPILOT_PLUGIN_DATA — it only injects
// CLAUDE_PLUGIN_ROOT, pointed at an install path under .vscode/agent-plugins/
// (#528). Without this fallback isCopilot was false, so ponytail assumed
// native Claude Code and emitted the statusline nudge, which VS Code Copilot
// doesn't read.
function isVsCodeCopilotRoot(pluginRoot) {
  if (!pluginRoot) return false;
  return pluginRoot.split(/[\\/]+/).includes('agent-plugins') &&
    pluginRoot.toLowerCase().includes('.vscode');
}

const isCopilot = Boolean(process.env.COPILOT_PLUGIN_DATA) ||
  isVsCodeCopilotRoot(process.env.CLAUDE_PLUGIN_ROOT);
const isCodex = !isCopilot && Boolean(process.env.PLUGIN_DATA);
const isQoder = !isCopilot && !isCodex && Boolean(process.env.QODER_SESSION_ID);
// Cursor (#817): CURSOR_VERSION is set only in the environment Cursor builds
// for hook processes (Cursor 3.20.17 assigns it in exactly one place, the hook
// env builder), so it never leaks into a Claude Code session running inside
// Cursor's terminal. Cursor also sets it when it runs a Claude-format plugin's
// hooks next to CLAUDE_PLUGIN_ROOT, and it needs Cursor-shaped JSON either
// way, so this check comes after the hosts with their own data dirs.
const isCursor = !isCopilot && !isCodex && !isQoder && Boolean(process.env.CURSOR_VERSION);

let stateDir = getClaudeDir();
if (isCodex) stateDir = process.env.PLUGIN_DATA;
// COPILOT_PLUGIN_DATA is unset under VS Code Copilot, so fall back to
// getClaudeDir() rather than building a path from undefined.
if (isCopilot) stateDir = process.env.COPILOT_PLUGIN_DATA || getClaudeDir();
if (isQoder) stateDir = path.join(os.homedir(), '.qoder');
if (isCursor) stateDir = path.join(os.homedir(), '.cursor');

// Qoder has no SessionStart event, so "no flag yet" is how the first prompt of a
// session is recognised. With one shared flag that meant turning ponytail off (by
// deleting the flag) looked like a brand-new session on the very next prompt, and
// the default level came straight back. Qoder names each session, so its state is
// kept per session and "off" is written explicitly instead of being an absence.
function qoderSessionKey(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe.slice(0, 64) || 'default';
}
const statePath = isQoder
  ? path.join(stateDir, STATE_FILE + '-' + qoderSessionKey(process.env.QODER_SESSION_ID))
  : path.join(stateDir, STATE_FILE);

// Per-session files are tiny, but they should not pile up forever.
const QODER_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function pruneStaleQoderState(now = Date.now()) {
  if (!isQoder) return;
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(STATE_FILE + '-')) continue;
      const file = path.join(stateDir, name);
      if (file === statePath) continue;
      try {
        if (now - fs.statSync(file).mtimeMs > QODER_STATE_MAX_AGE_MS) fs.unlinkSync(file);
      } catch (_) {}
    }
  } catch (_) {}
}

function setMode(mode) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, mode);
}

// Turning ponytail off. On Qoder the flag records "off" so the next prompt in this
// session does not mistake the absence for a fresh session. Elsewhere SessionStart
// sets the flag, so absence already means off and the statusline relies on it.
function clearMode() {
  if (isQoder) {
    try { setMode('off'); } catch (e) {}
    return;
  }
  try { fs.unlinkSync(statePath); } catch (e) {}
}

// Live mode written by activate/mode-tracker: a known level, 'off' when recorded
// explicitly, or null when there is no flag. Anything else in the file is treated
// as no flag rather than echoed back to the user.
function readMode() {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8').trim().toLowerCase();
  } catch (e) {
    return null;
  }
  if (raw === 'off') return 'off';
  return normalizePersistedMode(raw);
}

// Cursor's always-on project rule (.cursor/rules/ponytail.mdc) already puts the
// ruleset in front of every prompt and no hook can switch a rule off, so while
// it is in the workspace the hooks step back instead of injecting a second,
// possibly contradicting, copy (#817). Cursor hands every hook the workspace
// root as CURSOR_PROJECT_DIR; project hooks also run from that directory.
// ponytail: first workspace root only, a rule in a secondary folder of a
// multi-root workspace goes undetected.
function cursorRulePath() {
  const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const rule = path.join(root, '.cursor', 'rules', 'ponytail.mdc');
  return fs.existsSync(rule) ? rule : null;
}

function cursorRuleNotice(rule) {
  return 'PONYTAIL: the always-on Cursor rule ' + rule + ' is active in this workspace and ' +
    'already carries the ponytail ruleset, so the ponytail hooks injected nothing further. ' +
    'Mode switching (/ponytail lite|full|ultra|off, "stop ponytail") is unavailable while ' +
    'that rule exists. When the user tries to switch or turn off ponytail, tell them to ' +
    'delete that rule so hooks.json can manage the level.';
}

function writeHookOutput(event, mode, context = '') {
  if (isCopilot) {
    // Copilot reads additionalContext on SessionStart; ignores output elsewhere.
    process.stdout.write(JSON.stringify(
      event === 'SessionStart' && context ? { additionalContext: context } : {}));
    return;
  }
  if (isCodex) {
    const output = { systemMessage: `PONYTAIL:${mode.toUpperCase()}` };
    if (context) {
      output.hookSpecificOutput = {
        hookEventName: event,
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(output));
    return;
  }
  if (isQoder) {
    // Qoder: hookSpecificOutput JSON, same shape as Codex minus systemMessage.
    // UserPromptSubmit additionalContext is injected into the Agent's conversation.
    const output = {};
    if (context) {
      output.hookSpecificOutput = {
        hookEventName: event,
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(output));
    return;
  }
  if (isCursor) {
    // Cursor parses stdout as JSON and treats empty stdout as "nothing to
    // say"; raw text would be logged as a parse error. sessionStart takes
    // additional_context into the conversation's system context;
    // beforeSubmitPrompt needs continue:true and, in Cursor 3.20.17, injects
    // additional_context into that turn (docs/cursor-hooks.md).
    if (!context) return;
    const output = { additional_context: context };
    if (event === 'UserPromptSubmit') output.continue = true;
    process.stdout.write(JSON.stringify(output));
    return;
  }
  // Native Claude: SessionStart accepts raw stdout, but SubagentStart needs the
  // hookSpecificOutput JSON form or the context is dropped.
  if (event === 'SubagentStart') {
    process.stdout.write(JSON.stringify(
      { hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
    return;
  }
  process.stdout.write(context);
}

module.exports = {
  STATE_FILE,
  clearMode,
  pruneStaleQoderState,
  statePath,
  cursorRuleNotice,
  cursorRulePath,
  isCodex,
  isCopilot,
  isCursor,
  isQoder,
  readMode,
  setMode,
  writeHookOutput,
};

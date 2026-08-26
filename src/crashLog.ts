import * as vscode from 'vscode';
import { GatewayError } from './client';

/**
 * A "how did I get here" snapshot written to disk whenever a chat request
 * fails. The goal is to give a future debugging session enough context to
 * reproduce the failure without needing the user to reproduce it live.
 *
 * The file is written to the extension's global storage directory
 * (`context.globalStorageUri`), which persists across sessions and is the
 * conventional place for extension-owned data. The path is surfaced in the
 * error message shown to the user so they can attach it to a bug report.
 */

/** Redact anything that looks like a secret before it reaches disk. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    // API keys, bearer tokens, and long base64 blobs (image payloads) are
    // never useful in a crash log and can leak secrets. Replace them.
    return value
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/(data:image\/[^;]+;base64,)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Build a human-readable "how did I get here" report for a failed chat request.
 *
 * @param context   The extension context (for the storage path).
 * @param model     The model that was being used, if known.
 * @param error     The error that caused the failure.
 * @param snapshot  Optional request-time context captured by the caller.
 */
export function buildCrashReport(
  context: vscode.ExtensionContext,
  model: vscode.LanguageModelChatInformation | undefined,
  error: unknown,
  snapshot?: {
    messageCount?: number;
    estimatedInputTokens?: number;
    toolsOverhead?: number;
    modelMaxContext?: number;
    chosenMaxOutputTokens?: number | undefined;
    requestOptions?: Record<string, unknown>;
    config?: Record<string, unknown>;
  }
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push('==============================================================');
  lines.push(' Local Model Provider — crash report');
  lines.push(` Generated: ${now}`);
  lines.push('==============================================================');
  lines.push('');

  // --- Error ---------------------------------------------------------------
  lines.push('--- Error ---');
  if (error instanceof GatewayError) {
    lines.push(`  Type: GatewayError`);
    lines.push(`  Status code: ${error.statusCode ?? 'n/a'}`);
    lines.push(`  Retryable: ${error.isRetryable}`);
    if (error.originalError) {
      lines.push(`  Original error: ${error.originalError.message}`);
    }
  } else if (error instanceof Error) {
    lines.push(`  Type: ${error.name}`);
  } else {
    lines.push(`  Type: ${typeof error}`);
  }
  lines.push(`  Message: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    lines.push(`  Stack:`);
    for (const frame of error.stack.split('\n')) {
      lines.push(`    ${frame}`);
    }
  }
  lines.push('');

  // --- Model ---
  lines.push('Model');
  if (model) {
    lines.push(`  id: ${model.id}`);
    lines.push(`  family: ${model.family ?? 'n/a'}`);
    lines.push(`  version: ${model.version ?? 'n/a'}`);
    lines.push(`  maxInputTokens: ${model.maxInputTokens ?? 'n/a'}`);
    lines.push(`  maxOutputTokens: ${model.maxOutputTokens ?? 'n/a'}`);
    lines.push(`  capabilities: ${model.capabilities ? JSON.stringify(model.capabilities) : 'n/a'}`);
  } else {
    lines.push('  (unknown)');
  }
  lines.push('');

  // --- Token budget / request snapshot ---
  if (snapshot) {
    lines.push('Request snapshot');
    if (snapshot.messageCount !== undefined) {
      lines.push(`  messageCount: ${snapshot.messageCount}`);
    }
    if (snapshot.estimatedInputTokens !== undefined) {
      lines.push(`  estimatedInputTokens: ${snapshot.estimatedInputTokens}`);
    }
    if (snapshot.toolsOverhead !== undefined) {
      lines.push(`  toolsOverhead: ${snapshot.toolsOverhead}`);
    }
    if (snapshot.modelMaxContext !== undefined) {
      lines.push(`  modelMaxContext: ${snapshot.modelMaxContext}`);
    }
    if (snapshot.chosenMaxOutputTokens !== undefined) {
      lines.push(`  chosenMaxOutputTokens: ${snapshot.chosenMaxOutputTokens}`);
    }
    if (snapshot.requestOptions) {
      lines.push(`  requestOptions: ${JSON.stringify(redact(snapshot.requestOptions), null, 2)}`);
    }
    if (snapshot.config) {
      lines.push(`  config: ${JSON.stringify(redact(snapshot.config), null, 2)}`);
    }
    lines.push('');
  }

  lines.push('--- end of report ---');
  return lines.join('\n');
}

/**
 * Write a crash report to the extension's global storage directory and return
 * the absolute path to the file (or undefined if writing failed).
 *
 * Files are named `crash-<timestamp>.log` and are never overwritten, so a
 * sequence of failures produces an ordered history.
 */
export async function writeCrashReport(
  context: vscode.ExtensionContext,
  report: string
): Promise<string | undefined> {
  try {
    const dir = context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileUri = vscode.Uri.joinPath(dir, `crash-${timestamp}.log`);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(report, 'utf8'));
    return fileUri.fsPath;
  } catch (err) {
    // Never let logging itself break the user-facing error path.
    console.error('[Local Model Provider] Failed to write crash report:', err);
    return undefined;
  }
}
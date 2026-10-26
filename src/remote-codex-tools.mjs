import os from "node:os";
import { z } from "zod";
import { resolveCodexSenderContext } from "./codex-sender-context.mjs";
import { readCodexAccountContext } from "./codex-account-context.mjs";
import { captureProjectScope, recheckProjectScope } from "./project-scope.mjs";
import { decodeNativeToolResult } from "./native-relay.mjs";
import { exchangeRemoteRequest, readRemoteProfile, remoteFailure, repositoryIdentity, sameRemoteProfile, validateRemoteRequest } from "./remote-codex.mjs";

export function registerRemoteCodexTools(mcp, { nativeTools, runtime, reload,
  resolveSender = resolveCodexSenderContext, readAccount = readCodexAccountContext,
  readProfile = readRemoteProfile, captureScope = captureProjectScope, recheckScope = recheckProjectScope,
  repositoryIdentityOf = repositoryIdentity, exchange = exchangeRemoteRequest, hostname = os.hostname,
}) {
  mcp.registerTool("remote_codex", {
    title: "Send to Codex Desktop on another computer",
    description: "List, read or message existing Codex Desktop tasks through an explicitly configured SSH host. Requires bridge-remote-hosts.json and live host-supplied sender metadata. Each computer may use a different Codex account; the current accounts are rediscovered per call and cannot change during delivery. Select the exact saved project and task from list before send. Send requires Full access and a fresh UUID requestId; retain that ID after uncertainty, because retries only recover the durable receipt and never dispatch twice. Submitted means accepted, not completed; use read to verify the reply. Only send work explicitly authorized by the user. This does not delegate to Claude or run an external app-server.",
    inputSchema: {
      host: z.string().min(1).max(64).describe("Exact host name from bridge-remote-hosts.json"),
      action: z.enum(["list", "read", "send"]).describe("List matching tasks, read a selected task, or send an authorized message"),
      threadId: z.string().uuid().optional().describe("Exact remote task id from list; required for read and send"),
      message: z.string().min(1).max(50000).optional().describe("Authorized prompt for send; retain exactly on receipt recovery"),
      requestId: z.string().uuid().optional().describe("Fresh v4 UUID for a new send; preserve on retries"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => reload.run(async () => {
    try {
      runtime.assertCurrent();
      const readSender = () => resolveSender(extra?._meta, { inspectDesktopTask: async (threadId) => {
        const result = decodeNativeToolResult(await nativeTools.dispatchDesktop({ executorThreadId: threadId, operation: "read_thread", arguments: { threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 } }));
        return { thread: result.thread, latestTurnId: result.turns?.[0]?.id ?? null };
      } });
      const sender = await readSender();
      if (sender.status !== "verified") throw remoteFailure("CODEX_SENDER_CONTEXT_UNVERIFIED", sender.reason);
      if (args.action === "send" && sender.mode !== "bypass") throw remoteFailure("REMOTE_SENDER_PERMISSION", "Remote sending requires this Codex turn to use Full access; no permissions were changed");
      const account = readAccount();
      if (account.status !== "verified") throw remoteFailure("REMOTE_ACCOUNT_UNVERIFIED", account.reason);
      const profile = readProfile(args.host);
      const scope = captureScope(sender.cwd, profile.localCwd);
      const repository = repositoryIdentityOf(profile.localCwd);
      const check = async () => {
        runtime.assertCurrent();
        const current = await readSender();
        if (current.status !== "verified" || ["threadId", "turnId", "cwd", "mode"].some((key) => current[key] !== sender[key])) throw remoteFailure("CODEX_SENDER_CHANGED", "The sending Codex turn changed; inspect the destination before retrying");
        const currentAccount = readAccount();
        if (currentAccount.status !== "verified" || currentAccount.fingerprint !== account.fingerprint) throw remoteFailure("REMOTE_ACCOUNT_CHANGED", "The sending Codex account changed");
        sameRemoteProfile(profile, readProfile(args.host));
        recheckScope(scope);
        if (repositoryIdentityOf(profile.localCwd) !== repository) throw remoteFailure("REMOTE_PROJECT_CHANGED", "The sending repository changed");
      };
      await check();
      const request = { version: 1, action: args.action, cwd: profile.remoteCwd, repository, account: account.fingerprint,
        sender: { threadId: sender.threadId, mode: sender.mode, host: hostname() },
        ...(args.threadId ? { threadId: args.threadId } : {}), ...(args.message ? { message: args.message } : {}), ...(args.requestId ? { requestId: args.requestId } : {}) };
      validateRemoteRequest(request);
      const result = await exchange(profile, request);
      await check();
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `${error.code ?? "REMOTE_FAILED"}: ${error.message}` }] };
    }
  }));
}

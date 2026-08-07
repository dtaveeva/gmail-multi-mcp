import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserFacingError } from "../errors.js";
import { previewText, type OutgoingMessage } from "../gmail/mime.js";
import { AuditLog } from "../safety/audit.js";
import {
  assertCapability,
  assertRecipientsAllowed,
  parseAddresses,
} from "../safety/permissions.js";
import { guarded, resolve, text, type ToolContext, type ToolResult } from "./context.js";

/**
 * Banner placed at the top of a send preview, before any token exists.
 *
 * The sending account is the single easiest thing to get wrong in a
 * multi-account setup: an assistant picks a plausible mailbox the user never
 * named. The two-phase token binds the account — changing it between preview
 * and send invalidates the token — but binding is not the same as *checking*.
 * It stops a swap after the preview; it does nothing about a wrong choice made
 * before it. So the preview states the sender out loud and asks for it to be
 * confirmed whenever the user did not choose it themselves.
 */
export function senderConfirmationBanner(email: string): string {
  return (
    `SENDING ACCOUNT — confirm before you send\n` +
    `  This message will be sent FROM: ${email}\n` +
    `  If the user did not explicitly choose this account, confirm with them\n` +
    `  that it is the right one to send from before redeeming the token.\n\n`
  );
}

/** Renders the phase-1 response: what will happen, and how to authorise it. */
function previewResponse(
  ctx: ToolContext,
  toolName: string,
  summary: string,
  issued: { token: string; expiresAt: number; outOfBand: boolean },
): ToolResult {
  const expiry = new Date(issued.expiresAt).toISOString();
  const instruction = issued.outOfBand
    ? `A confirmation token has been printed to the server's terminal.\n` +
      `Show this preview to the user and ask them to read the token back to you.\n` +
      `Then call ${toolName} again with identical arguments plus confirm_token.`
    : `NOTHING HAS BEEN SENT OR CHANGED YET.\n` +
      `To proceed, call ${toolName} again with identical arguments plus:\n` +
      `  confirm_token: "${issued.token}"\n` +
      `Changing any argument invalidates this token.`;

  return text(
    `PREVIEW — confirmation required (expires ${expiry})\n` +
      `${"=".repeat(60)}\n${summary}\n${"=".repeat(60)}\n\n${instruction}`,
  );
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  /* ---------------------------------------------------------------- *
   * Drafts: reversible, never leave the mailbox, so no confirmation.
   * This is what the `draft` tier exists to make safe and useful.
   * ---------------------------------------------------------------- */
  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create a Gmail draft",
      description:
        "Save a draft in the account. Drafts are never sent by this tool — a human " +
        "sends them from Gmail, or gmail_send_draft does after confirmation.",
      inputSchema: {
        account: z.string(),
        to: z.array(z.string()).min(1),
        subject: z.string(),
        body: z.string(),
        cc: z.array(z.string()).optional(),
        reply_to_message_id: z
          .string()
          .optional()
          .describe("Thread this draft as a reply to the given message id"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ account, to, subject, body, cc, reply_to_message_id }) =>
      guarded(ctx, "gmail_create_draft", "execute", () => account, async () => {
        const { account: acct, mailbox } = await resolve(ctx, account);
        assertCapability(acct, "draft", ctx.cfg);
        assertRecipientsAllowed(acct, [...to, ...(cc ?? [])].flatMap(parseAddresses));
        ctx.limiter.consume(acct.email, "mutation");

        const threading = reply_to_message_id
          ? await mailbox.threadingFor(reply_to_message_id)
          : undefined;

        const msg: OutgoingMessage = {
          from: acct.email,
          to,
          ...(cc?.length ? { cc } : {}),
          subject,
          body,
          ...(threading ? { inReplyTo: threading.messageId, references: threading.references } : {}),
        };

        await ctx.audit.record({
          ts: new Date().toISOString(),
          tool: "gmail_create_draft",
          account: acct.email,
          phase: "execute",
          outcome: "ok",
          detail: { to, cc, subject, body: AuditLog.digest(body), dryRun: ctx.cfg.dryRun },
        });

        if (ctx.cfg.dryRun) {
          return text(`DRY RUN — draft not created.\n\n${previewText(msg)}`);
        }

        const draftId = await mailbox.createDraft(msg, threading);

        return text(
          `Draft saved in ${acct.email}.\n  draft id: ${draftId}\n\n${previewText(msg)}`,
        );
      }),
  );

  /* ---------------------------------------------------------------- *
   * Send: irreversible, leaves the mailbox. Two-phase, rate limited.
   * ---------------------------------------------------------------- */
  server.registerTool(
    "gmail_send",
    {
      title: "Send an email (two-phase)",
      description:
        "Send mail from a connected account. Call WITHOUT confirm_token first to get " +
        "a preview and a token; call again with identical arguments plus the token to " +
        "actually send. Never invent a token — one you did not receive will be rejected. " +
        "If the user did not say which account to send from, confirm the sending account " +
        "with them before sending — the preview restates it for exactly that check.",
      inputSchema: {
        account: z.string(),
        to: z.array(z.string()).min(1),
        subject: z.string(),
        body: z.string(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        reply_to_message_id: z.string().optional(),
        confirm_token: z
          .string()
          .optional()
          .describe("Omit on the first call. Supply the token from the preview to send."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ account, to, subject, body, cc, bcc, reply_to_message_id, confirm_token }) =>
      guarded(
        ctx,
        "gmail_send",
        confirm_token ? "execute" : "preview",
        () => account,
        async () => {
          const { account: acct, mailbox } = await resolve(ctx, account);
          assertCapability(acct, "send", ctx.cfg);

          const recipients = [...to, ...(cc ?? []), ...(bcc ?? [])].flatMap(parseAddresses);
          if (!recipients.length) {
            throw new UserFacingError("No valid email address found in the recipients.");
          }
          assertRecipientsAllowed(acct, recipients);

          const threading = reply_to_message_id
            ? await mailbox.threadingFor(reply_to_message_id)
            : undefined;

          const msg: OutgoingMessage = {
            from: acct.email,
            to,
            ...(cc?.length ? { cc } : {}),
            ...(bcc?.length ? { bcc } : {}),
            subject,
            body,
            ...(threading ? { inReplyTo: threading.messageId, references: threading.references } : {}),
          };

          // Fingerprint covers exactly the user-supplied arguments, so any change
          // between preview and confirmation invalidates the token.
          const payload = { to, cc, bcc, subject, body, reply_to_message_id };

          if (!confirm_token) {
            const issued = ctx.confirmations.issue("gmail_send", acct.email, payload);
            await ctx.audit.record({
              ts: new Date().toISOString(),
              tool: "gmail_send",
              account: acct.email,
              phase: "preview",
              outcome: "ok",
              detail: { to, cc, bcc, subject, body: AuditLog.digest(body) },
            });
            return previewResponse(
              ctx,
              "gmail_send",
              senderConfirmationBanner(acct.email) + previewText(msg),
              issued,
            );
          }

          ctx.confirmations.redeem(confirm_token, "gmail_send", acct.email, payload);
          ctx.limiter.consume(acct.email, "send");

          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_send",
            account: acct.email,
            phase: "execute",
            outcome: "ok",
            detail: { to, cc, bcc, subject, body: AuditLog.digest(body), dryRun: ctx.cfg.dryRun },
          });

          if (ctx.cfg.dryRun) {
            return text(`DRY RUN — nothing was sent.\n\n${previewText(msg)}`);
          }

          const sentId = await mailbox.send(msg, threading);

          return text(
            `Sent from ${acct.email}.\n  message id: ${sentId}\n` +
              `  remaining sends this hour: ${ctx.limiter.remaining(acct.email, "send")}\n\n` +
              previewText(msg),
          );
        },
      ),
  );

  server.registerTool(
    "gmail_send_draft",
    {
      title: "Send an existing draft (two-phase)",
      description:
        "Send a draft that already exists. Call without confirm_token to preview it, " +
        "then again with the token to send.",
      inputSchema: {
        account: z.string(),
        draft_id: z.string(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ account, draft_id, confirm_token }) =>
      guarded(
        ctx,
        "gmail_send_draft",
        confirm_token ? "execute" : "preview",
        () => account,
        async () => {
          const { account: acct, mailbox } = await resolve(ctx, account);
          assertCapability(acct, "send", ctx.cfg);

          const parsed = await mailbox.getDraft(draft_id);
          assertRecipientsAllowed(acct, parseAddresses(`${parsed.to} ${parsed.cc}`));

          const summary =
            `From:    ${acct.email}\nTo:      ${parsed.to}\n` +
            (parsed.cc ? `Cc:      ${parsed.cc}\n` : "") +
            `Subject: ${parsed.subject}\n\n${parsed.body}`;

          if (!confirm_token) {
            const issued = ctx.confirmations.issue("gmail_send_draft", acct.email, { draft_id });
            await ctx.audit.record({
              ts: new Date().toISOString(),
              tool: "gmail_send_draft",
              account: acct.email,
              phase: "preview",
              outcome: "ok",
              detail: { draftId: draft_id, to: parsed.to, subject: parsed.subject },
            });
            return previewResponse(
              ctx,
              "gmail_send_draft",
              senderConfirmationBanner(acct.email) + summary,
              issued,
            );
          }

          ctx.confirmations.redeem(confirm_token, "gmail_send_draft", acct.email, { draft_id });
          ctx.limiter.consume(acct.email, "send");

          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_send_draft",
            account: acct.email,
            phase: "execute",
            outcome: "ok",
            detail: { draftId: draft_id, to: parsed.to, subject: parsed.subject, dryRun: ctx.cfg.dryRun },
          });

          if (ctx.cfg.dryRun) return text(`DRY RUN — draft not sent.\n\n${summary}`);

          const sentId = await mailbox.sendDraft(draft_id);
          return text(`Draft sent from ${acct.email}.\n  message id: ${sentId}\n\n${summary}`);
        },
      ),
  );

  /* ---------------------------------------------------------------- *
   * Label changes and trash. Reversible, but bulk operations can hide
   * a lot of mail at once, so both are confirmed.
   * ---------------------------------------------------------------- */
  server.registerTool(
    "gmail_modify_labels",
    {
      title: "Add or remove labels (two-phase)",
      description:
        "Apply or remove labels on messages. Removing INBOX archives a message. " +
        "Preview first, then confirm with the token.",
      inputSchema: {
        account: z.string(),
        message_ids: z.array(z.string()).min(1).max(100),
        add_label_ids: z.array(z.string()).optional(),
        remove_label_ids: z.array(z.string()).optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ account, message_ids, add_label_ids, remove_label_ids, confirm_token }) =>
      guarded(
        ctx,
        "gmail_modify_labels",
        confirm_token ? "execute" : "preview",
        () => account,
        async () => {
          const { account: acct, mailbox } = await resolve(ctx, account);
          assertCapability(acct, "modify", ctx.cfg);

          if (!add_label_ids?.length && !remove_label_ids?.length) {
            throw new UserFacingError("Specify at least one label to add or remove.");
          }

          const payload = { message_ids, add_label_ids, remove_label_ids };
          const summary =
            `Account:  ${acct.email}\nMessages: ${message_ids.length}\n` +
            `Add:      ${add_label_ids?.join(", ") || "none"}\n` +
            `Remove:   ${remove_label_ids?.join(", ") || "none"}\n` +
            (remove_label_ids?.includes("INBOX")
              ? `\nNote: removing INBOX archives these messages.\n`
              : "") +
            `\nIds: ${message_ids.slice(0, 20).join(", ")}` +
            (message_ids.length > 20 ? ` … +${message_ids.length - 20} more` : "");

          if (!confirm_token) {
            const issued = ctx.confirmations.issue("gmail_modify_labels", acct.email, payload);
            return previewResponse(ctx, "gmail_modify_labels", summary, issued);
          }

          ctx.confirmations.redeem(confirm_token, "gmail_modify_labels", acct.email, payload);
          ctx.limiter.consume(acct.email, "mutation");

          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_modify_labels",
            account: acct.email,
            phase: "execute",
            outcome: "ok",
            detail: { count: message_ids.length, add_label_ids, remove_label_ids, dryRun: ctx.cfg.dryRun },
          });

          if (ctx.cfg.dryRun) return text(`DRY RUN — no labels changed.\n\n${summary}`);

          await mailbox.modifyLabels(message_ids, add_label_ids ?? [], remove_label_ids ?? []);

          return text(`Updated labels on ${message_ids.length} message(s) in ${acct.email}.`);
        },
      ),
  );

  server.registerTool(
    "gmail_trash",
    {
      title: "Move messages to Trash (two-phase)",
      description:
        "Move messages to Trash, where Gmail keeps them for 30 days and the user can " +
        "restore them. This server has no permanent-delete tool by design.",
      inputSchema: {
        account: z.string(),
        message_ids: z.array(z.string()).min(1).max(100),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ account, message_ids, confirm_token }) =>
      guarded(
        ctx,
        "gmail_trash",
        confirm_token ? "execute" : "preview",
        () => account,
        async () => {
          const { account: acct, mailbox } = await resolve(ctx, account);
          assertCapability(acct, "modify", ctx.cfg);

          const payload = { message_ids };
          const summary =
            `Account:  ${acct.email}\nMessages: ${message_ids.length} → Trash\n` +
            `Recoverable from Trash for 30 days.\n\n` +
            `Ids: ${message_ids.slice(0, 20).join(", ")}` +
            (message_ids.length > 20 ? ` … +${message_ids.length - 20} more` : "");

          if (!confirm_token) {
            const issued = ctx.confirmations.issue("gmail_trash", acct.email, payload);
            return previewResponse(ctx, "gmail_trash", summary, issued);
          }

          ctx.confirmations.redeem(confirm_token, "gmail_trash", acct.email, payload);
          ctx.limiter.consume(acct.email, "mutation");

          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_trash",
            account: acct.email,
            phase: "execute",
            outcome: "ok",
            detail: { count: message_ids.length, ids: message_ids, dryRun: ctx.cfg.dryRun },
          });

          if (ctx.cfg.dryRun) return text(`DRY RUN — nothing was trashed.\n\n${summary}`);

          await mailbox.trash(message_ids);
          return text(`Moved ${message_ids.length} message(s) to Trash in ${acct.email}.`);
        },
      ),
  );
}


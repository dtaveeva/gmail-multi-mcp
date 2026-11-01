import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserFacingError } from "../errors.js";
import { forgetCreatedDraft, isCreatedDraft } from "../safety/created-drafts.js";
import { assertCapability } from "../safety/permissions.js";
import { contain } from "../safety/untrusted.js";
import { guarded, resolve, text, type ToolContext } from "./context.js";
import { previewResponse } from "./write.js";

export function registerDraftTools(server: McpServer, ctx: ToolContext): void {
  /* ---------------------------------------------------------------- *
   * Drafts: list and delete. Listing gives the draft ids the other
   * draft tools need (search returns message ids, not draft ids).
   * Deleting is permanent — Gmail drafts never pass through Trash — so
   * it is two-phase, and it only ever touches drafts, never sent mail.
   * ---------------------------------------------------------------- */
  server.registerTool(
    "gmail_list_drafts",
    {
      title: "List drafts",
      description:
        "List drafts in the account, newest first, with the draft id that " +
        "gmail_send_draft and gmail_delete_draft take. Optional Gmail query narrows it.",
      inputSchema: {
        account: z.string(),
        query: z.string().optional().describe("Gmail search query, e.g. 'subject:invoice'"),
        max_results: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account, query, max_results }) =>
      guarded(ctx, "gmail_list_drafts", "read", () => account, async () => {
        const { account: acct, mailbox } = await resolve(ctx, account);
        assertCapability(acct, "read", ctx.cfg);
        const drafts = await mailbox.listDrafts(max_results, query);
        if (!drafts.length) return text(`No drafts in ${acct.email}${query ? ` for: ${query}` : ""}.`);
        const lines = drafts.map(
          (d, i) =>
            `[${i + 1}] draft_id=${d.draftId} message_id=${d.messageId}\n` +
            `    to: ${d.to}\n    subject: ${d.subject}\n    date: ${d.date}`,
        );
        // A draft can be a reply that quotes external mail, so subjects are
        // fenced like any other mail content.
        const contained = contain(lines.join("\n\n"), "DRAFT LIST");
        return text(`${drafts.length} draft(s) in ${acct.email}.\n\n${contained.text}`);
      }),
  );

  server.registerTool(
    "gmail_delete_draft",
    {
      title: "Delete a draft (two-phase)",
      description:
        "Permanently delete one draft that this server created (gmail_create_draft). " +
        "Gmail drafts do not go to Trash, so this cannot be undone. Drafts the user " +
        "wrote in Gmail, and sent or received mail, are refused. Call without " +
        "confirm_token to preview, then again with the token to delete.",
      inputSchema: {
        account: z.string(),
        draft_id: z.string().describe("Draft id from gmail_list_drafts"),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ account, draft_id, confirm_token }) =>
      guarded(
        ctx,
        "gmail_delete_draft",
        confirm_token ? "execute" : "preview",
        () => account,
        async () => {
          const { account: acct, mailbox } = await resolve(ctx, account);
          assertCapability(acct, "draft", ctx.cfg);

          const parsed = await mailbox.getDraft(draft_id);
          if (!(await isCreatedDraft(ctx.cfg.home, acct.email, draft_id, parsed.id))) {
            throw new UserFacingError(
              `Draft ${draft_id} is not one this server created (or it has changed since), so it will not be deleted.`,
              "Only drafts made with gmail_create_draft, and not edited since, can be " +
                "deleted here. Delete other drafts in Gmail yourself.",
            );
          }

          const details = contain(
            `To:      ${parsed.to}\nSubject: ${parsed.subject}\nDate:    ${parsed.date}\n` +
              (parsed.attachments.length
                ? `Attachments: ${parsed.attachments.map((a) => a.filename).join(", ")}\n`
                : "") +
              `\n${parsed.body.slice(0, 1000)}`,
            "DRAFT",
          );
          const summary =
            `Account: ${acct.email}\nDelete draft ${draft_id} PERMANENTLY (drafts skip Trash).\n\n` +
            details.text;
          // Bind the token to the message id as well: on the REST backend an
          // edited draft gets a new message id, so the preview stays honest.
          const payload = { draft_id, message_id: parsed.id };

          if (!confirm_token) {
            const issued = ctx.confirmations.issue("gmail_delete_draft", acct.email, payload);
            await ctx.audit.record({
              ts: new Date().toISOString(),
              tool: "gmail_delete_draft",
              account: acct.email,
              phase: "preview",
              outcome: "ok",
              detail: { draftId: draft_id, to: parsed.to, subject: parsed.subject },
            });
            return previewResponse(ctx, "gmail_delete_draft", summary, issued);
          }

          ctx.confirmations.redeem(confirm_token, "gmail_delete_draft", acct.email, payload);
          ctx.limiter.consume(acct.email, "mutation");

          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_delete_draft",
            account: acct.email,
            phase: "execute",
            outcome: "ok",
            detail: { draftId: draft_id, to: parsed.to, subject: parsed.subject, dryRun: ctx.cfg.dryRun },
          });

          if (ctx.cfg.dryRun) return text(`DRY RUN — draft not deleted.\n\n${summary}`);

          await mailbox.deleteDraft(draft_id, parsed.id);
          await forgetCreatedDraft(ctx.cfg.home, acct.email, draft_id);
          return text(`Deleted draft ${draft_id} from ${acct.email}.`);
        },
      ),
  );
}

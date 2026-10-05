CREATE TABLE "OutreachReply" (
    "id" UUID NOT NULL,
    "outreachId" UUID NOT NULL,
    "mailboxAccount" VARCHAR(254),
    "gmailMessageId" VARCHAR(200),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "summary" VARCHAR(2000),
    "outcome" "ReplyOutcome",
    "classifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachReply_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OutreachReply_identity_pair" CHECK (
        ("mailboxAccount" IS NULL) = ("gmailMessageId" IS NULL)
    )
);

CREATE UNIQUE INDEX "OutreachReply_mailboxAccount_gmailMessageId_key"
    ON "OutreachReply"("mailboxAccount", "gmailMessageId");
CREATE INDEX "OutreachReply_outreachId_receivedAt_idx"
    ON "OutreachReply"("outreachId", "receivedAt");
ALTER TABLE "OutreachReply" ADD CONSTRAINT "OutreachReply_outreachId_fkey"
    FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the known legacy snapshot without changing Outreach or inventing
-- mailbox/message identities or an unknown historical classification time.
INSERT INTO "OutreachReply" ("id", "outreachId", "receivedAt", "summary", "outcome")
SELECT gen_random_uuid(), "id", "repliedAt", "replySummary", "replyOutcome"
FROM "Outreach"
WHERE "repliedAt" IS NOT NULL;

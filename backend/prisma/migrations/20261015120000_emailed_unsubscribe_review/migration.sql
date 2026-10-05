CREATE TYPE "UnsubscribeReviewState" AS ENUM ('open', 'resolved', 'dismissed');
CREATE TYPE "UnsubscribeReviewReason" AS ENUM ('invalid_sender', 'missing_received_time', 'multiple_candidates', 'sender_conflict', 'unverified_send', 'historical_mail');

CREATE TABLE "EmailedUnsubscribeReview" (
    "id" UUID NOT NULL,
    "mailboxAccount" VARCHAR(254) NOT NULL,
    "gmailMessageId" VARCHAR(200) NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "senderEmail" VARCHAR(254),
    "reason" "UnsubscribeReviewReason" NOT NULL,
    "state" "UnsubscribeReviewState" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedOutreachId" UUID,
    CONSTRAINT "EmailedUnsubscribeReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailedUnsubscribeReview_resolution_state" CHECK (
        ("state" = 'open' AND "resolvedAt" IS NULL AND "resolvedOutreachId" IS NULL) OR
        ("state" = 'dismissed' AND "resolvedAt" IS NOT NULL AND "resolvedOutreachId" IS NULL) OR
        ("state" = 'resolved' AND "resolvedAt" IS NOT NULL)
    )
);

CREATE TABLE "EmailedUnsubscribeCandidate" (
    "reviewId" UUID NOT NULL,
    "outreachId" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "recipientEmail" VARCHAR(254) NOT NULL,
    CONSTRAINT "EmailedUnsubscribeCandidate_pkey" PRIMARY KEY ("reviewId", "outreachId")
);

CREATE UNIQUE INDEX "EmailedUnsubscribeReview_mailboxAccount_gmailMessageId_key" ON "EmailedUnsubscribeReview"("mailboxAccount", "gmailMessageId");
CREATE INDEX "EmailedUnsubscribeReview_state_createdAt_idx" ON "EmailedUnsubscribeReview"("state", "createdAt");
CREATE INDEX "EmailedUnsubscribeCandidate_outreachId_idx" ON "EmailedUnsubscribeCandidate"("outreachId");
ALTER TABLE "EmailedUnsubscribeReview" ADD CONSTRAINT "EmailedUnsubscribeReview_resolvedOutreachId_fkey" FOREIGN KEY ("resolvedOutreachId") REFERENCES "Outreach"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailedUnsubscribeCandidate" ADD CONSTRAINT "EmailedUnsubscribeCandidate_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "EmailedUnsubscribeReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailedUnsubscribeCandidate" ADD CONSTRAINT "EmailedUnsubscribeCandidate_outreachId_fkey" FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

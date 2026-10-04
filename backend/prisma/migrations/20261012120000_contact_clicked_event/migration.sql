-- Design Partner v1. Additive only: one new analytics event type, sent when a
-- visitor clicks "Talk to ReclaimBay" or copies the contact address. No new
-- table and no new column; the event carries the existing allow-listed fields.

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'contact_clicked';

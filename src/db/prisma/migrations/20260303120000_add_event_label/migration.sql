-- CreateTable
CREATE TABLE "event_label" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "git_sha" TEXT,
    "snapshot_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_label_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_label_event_id_idx" ON "event_label"("event_id");

-- CreateIndex
CREATE INDEX "event_label_label_idx" ON "event_label"("label");

-- CreateIndex
CREATE INDEX "event_label_created_at_idx" ON "event_label"("created_at" DESC);

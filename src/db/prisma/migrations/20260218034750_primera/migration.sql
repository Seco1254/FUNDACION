-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('DISCOVERED', 'NORMALIZED', 'POLICY_OK', 'POLICY_BLOCKED');

-- CreateEnum
CREATE TYPE "BlockedReason" AS ENUM ('NOT_ALLOWLISTED', 'NOT_SPANISH', 'NO_EXTRACT', 'DUPLICATE_URL', 'PARSE_FAIL');

-- CreateEnum
CREATE TYPE "EventState" AS ENUM ('DETECTED', 'PENDING_PUBLISH', 'PUBLISHED', 'UPDATING', 'DORMANT', 'CLOSED');

-- CreateEnum
CREATE TYPE "GateStatus" AS ENUM ('PASS', 'FAIL', 'NA');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('FACT', 'ALLEGATION', 'FORECAST', 'OPINION', 'QUANT');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('SUPPORTED', 'DISPUTED', 'INSUFFICIENT');

-- CreateEnum
CREATE TYPE "QuoteStrength" AS ENUM ('WEAK', 'MEDIUM', 'STRONG');

-- CreateEnum
CREATE TYPE "QuoteRole" AS ENUM ('EVIDENCE', 'ATTRIBUTION', 'CONTEXT');

-- CreateEnum
CREATE TYPE "BiasScope" AS ENUM ('MEDIA_LEVEL', 'ARTICLE_LEVEL');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('ARTICLE', 'EVENT', 'EVENT_VERSION', 'MERGE', 'SUB_EVENT', 'OVERVIEW', 'CLAIM', 'BIAS', 'TOPIC');

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "media_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowlisted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article" (
    "id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "text_norm" TEXT,
    "status" "ArticleStatus" NOT NULL DEFAULT 'DISCOVERED',
    "blocked_reason" "BlockedReason",
    "embedding_model" TEXT,
    "embedding_vec" JSONB,
    "embedding_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event" (
    "id" UUID NOT NULL,
    "state" "EventState" NOT NULL DEFAULT 'DETECTED',
    "t0" TIMESTAMP(3),
    "t_last" TIMESTAMP(3),
    "publish_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "canonical_event_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_article" (
    "event_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_article_pkey" PRIMARY KEY ("event_id","article_id")
);

-- CreateTable
CREATE TABLE "event_version" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "version_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gate_status" "GateStatus" NOT NULL DEFAULT 'NA',
    "headline" TEXT,
    "packet_json" JSONB NOT NULL DEFAULT '{}',
    "diff_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "event_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "claim_text" TEXT NOT NULL,
    "claim_type" "ClaimType" NOT NULL,
    "status" "ClaimStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "quote_text" TEXT NOT NULL,
    "span_start" INTEGER,
    "span_end" INTEGER,
    "strength" "QuoteStrength" NOT NULL,
    "role" "QuoteRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bias_label" (
    "id" UUID NOT NULL,
    "scope" "BiasScope" NOT NULL,
    "media_id" UUID,
    "article_id" UUID,
    "event_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "label_primary" TEXT NOT NULL,
    "label_secondary" TEXT,
    "intensity" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bias_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_assignment" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "topic_key" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_profile" (
    "media_id" UUID NOT NULL,
    "profile_json" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_profile_pkey" PRIMARY KEY ("media_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_media_key_key" ON "media"("media_key");

-- CreateIndex
CREATE UNIQUE INDEX "article_url_key" ON "article"("url");

-- CreateIndex
CREATE INDEX "event_state_idx" ON "event"("state");

-- CreateIndex
CREATE INDEX "event_published_at_idx" ON "event"("published_at" DESC);

-- CreateIndex
CREATE INDEX "event_t_last_idx" ON "event"("t_last" DESC);

-- CreateIndex
CREATE INDEX "event_article_event_id_idx" ON "event_article"("event_id");

-- CreateIndex
CREATE INDEX "event_article_article_id_idx" ON "event_article"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_article_event_id_article_id_key" ON "event_article"("event_id", "article_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_version_event_id_version_index_key" ON "event_version"("event_id", "version_index");

-- CreateIndex
CREATE INDEX "claim_event_id_version_id_idx" ON "claim"("event_id", "version_id");

-- CreateIndex
CREATE INDEX "quote_claim_id_idx" ON "quote"("claim_id");

-- CreateIndex
CREATE INDEX "quote_article_id_idx" ON "quote"("article_id");

-- CreateIndex
CREATE INDEX "bias_label_event_id_version_id_idx" ON "bias_label"("event_id", "version_id");

-- CreateIndex
CREATE INDEX "bias_label_media_id_event_id_idx" ON "bias_label"("media_id", "event_id");

-- CreateIndex
CREATE INDEX "bias_label_article_id_idx" ON "bias_label"("article_id");

-- CreateIndex
CREATE INDEX "topic_assignment_event_id_version_id_idx" ON "topic_assignment"("event_id", "version_id");

-- CreateIndex
CREATE INDEX "topic_assignment_topic_key_idx" ON "topic_assignment"("topic_key");

-- CreateIndex
CREATE INDEX "topic_assignment_article_id_idx" ON "topic_assignment"("article_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_id_idx" ON "audit_log"("entity_id");

-- CreateIndex
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "article" ADD CONSTRAINT "article_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_canonical_event_id_fkey" FOREIGN KEY ("canonical_event_id") REFERENCES "event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_article" ADD CONSTRAINT "event_article_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_article" ADD CONSTRAINT "event_article_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_version" ADD CONSTRAINT "event_version_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "event_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

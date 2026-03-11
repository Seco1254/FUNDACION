# FUNDACION — Architectural State Report

**Fecha**: 2026-02-20
**Autor**: Auditoría automatizada (Claude, Principal Engineer)
**Propósito**: Documento de transferencia para arquitecto externo. Describe el sistema TAL COMO ES, no como debería ser.
**Versión del código**: Branch `claude/diagnose-feed-events-JlLDA`

---

## Tabla de contenido

1. [Arquitectura real](#1-arquitectura-real)
2. [Base de datos](#2-base-de-datos)
3. [Scheduler y ciclo de vida](#3-scheduler-y-ciclo-de-vida)
4. [Lógica del feed](#4-lógica-del-feed)
5. [Overview y LLM](#5-overview-y-llm)
6. [Observabilidad](#6-observabilidad)
7. [Deuda técnica](#7-deuda-técnica)
8. [Riesgos sistémicos](#8-riesgos-sistémicos)
9. [Métricas reales](#9-métricas-reales)
10. [Resumen ejecutivo](#10-resumen-ejecutivo)

---

## 1. Arquitectura real

### 1.1 Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js + TypeScript (ESM) |
| HTTP | Fastify |
| ORM | Prisma Client |
| DB | PostgreSQL |
| Bus de eventos | In-memory (custom `EventBus`) |
| Scheduler | In-memory (custom `Scheduler`) |
| LLM | Anthropic Claude (opcional, con fallback heurístico) |
| Embeddings | Hash-based determinístico (NO neural) — 256 dimensiones |
| Cache | In-memory LRU con TTL (custom `Cache`) |
| Rate limiter | In-memory sliding window (custom `RateLimiter`) |

### 1.2 Estructura del código

```
src/
├── api/routes/           # 10 rutas HTTP (4 públicas + 6 debug)
├── core/                 # 10 módulos de infraestructura
│   ├── async/            #   withTimeout
│   ├── cache/            #   Cache LRU + SingleFlight + invalidation
│   ├── errors/           #   Error types
│   ├── event_bus/        #   EventBus, Dispatcher, Envelope, Validator
│   ├── http/             #   RateLimiter
│   ├── llm/              #   LlmClient, prompts, gates, facts-extractor, dedup, teaser
│   ├── logging/          #   Pino logger + trace middleware
│   ├── metrics/          #   In-memory counters + subscribers
│   ├── scheduler/        #   Scheduler (setInterval + Map<jobKey, ScheduledJob>)
│   └── time/             #   Clock abstraction (RealClock / TestClock)
├── db/                   # Prisma client + schema
├── modules/              # 19 módulos de dominio
│   ├── articles/         #   ArticleRepository
│   ├── audit/            #   AuditRepository, AuditService
│   ├── bias/             #   BiasProfiler, BiasLabelRepo, MediaProfileRepo
│   ├── claims/           #   ClaimQuoteExtractor, ClaimRepository
│   ├── embedding/        #   EmbeddingService, hash-vector
│   ├── event_linker/     #   EventLinkerV2, pair-scorer, similarity, hard-negative-gates, split-detector, config
│   ├── events/           #   EventRepository
│   ├── feed/             #   FeedService, FeedRepository, evidence-level, types
│   ├── ingestion/        #   ScrapeOrchestrator, FetcherParser, PolicyGuard, scrapers/registry
│   ├── lifecycle/        #   LifecycleManager (state machine)
│   ├── media/            #   MediaRepository
│   ├── overview/         #   OverviewGenerator, ai-enrichment
│   ├── quality/          #   QualitySnapshotService (debug metrics)
│   ├── ranking/          #   RankingService, event-scorer, junk-scorer
│   ├── subevents/        #   SubEventBuilder
│   ├── text_sanitizer/   #   sanitizeText (normalización de texto)
│   ├── topics/           #   TopicAssigner, TopicAssignmentRepo
│   ├── versioning/       #   VersioningHandler
│   └── versions/         #   VersionRepository
└── server.ts             # Composición root (DI manual)

Estadísticas:
  136 archivos fuente (.ts)
   56 archivos de test (.test.ts)
  ~21,700 líneas de TypeScript total
```

### 1.3 Mapa del pipeline (flujo real de eventos)

```
                              ┌─────────────────────────────┐
                              │     ScrapeOrchestrator       │
                              │  (scheduler: cada 15 min)    │
                              └──────────┬──────────────────┘
                                         │ ArticleDiscovered
                                         ▼
                              ┌─────────────────────────────┐
                              │       FetcherParser          │
                              │  (fetch HTML, parse, norm)   │
                              └──────────┬──────────────────┘
                                         │ ArticleNormalized
                                         ▼
                              ┌─────────────────────────────┐
                              │        PolicyGuard           │
                              │  (idioma, allowlist, len)    │
                              └──────┬──────────┬───────────┘
                            OK │          │ BLOCKED
                               ▼          ▼ (fin)
                   ArticlePolicyOk   ArticlePolicyBlocked
                               │
                               ▼
                    ┌─────────────────────┐
                    │  EmbeddingService    │
                    │  (hash 256-dim)      │
                    └─────────┬───────────┘
                              │ ArticleEmbedded
                              ▼
                    ┌─────────────────────┐
                    │   EventLinkerV2      │
                    │  (scoring + gates    │
                    │   + two-step)        │
                    └────┬──────┬─────────┘
                   LINK  │      │ CREATE
                         │      ▼
                         │   EventCreated ──────────────────────────┐
                         │                                          │
                         ▼                                          ▼
              ArticleLinkedToEvent                     LifecycleManager
              (LINKED_EXISTING)                     .handleEventCreated()
                         │                                │
                         ▼                                │ state → PENDING_PUBLISH
              LifecycleManager                            │ scheduler: publish en 5 min
           .handleArticleLinked()                         │
                    │                                     ▼
                    │  tLast = now              EventPublishScheduled
                    │                                     │
                    ▼                                     │ (5 min delay)
           EventUpdateTriggered                           ▼
                    │                           executePublish()
                    │                              │ state → PUBLISHED
                    ▼                              ▼
           VersioningHandler              EventPublished
           (snapshot versión)                   │
                    │                           │
                    ▼                           ▼
        EventVersionCommitted        AiPipeline.onPublished
                    │                (si no tiene enrichment aún)
                    ▼                           │
         ClaimQuoteExtractor          ┌─────────┘
         (heurístico o LLM)           │ Ejecuta claims + overview
                    │                 │ vía los mismos handlers
                    ▼                 │
           ClaimGraphBuilt ◄──────────┘
                    │
                    ▼
         OverviewGenerator
         (LLM o heurístico)
                    │
                    ▼
          OverviewGenerated
               │         │
               ▼         ▼
        TopicAssigner  BiasProfiler
               │
               ▼
        TopicHeatmapBuilt
               │
               ▼
        SubEventBuilder
```

### 1.4 Diagrama de suscripciones EventBus (server.ts real)

```
ArticleDiscovered       → FetcherParser
ArticleNormalized       → PolicyGuard
ArticlePolicyOk         → EmbeddingService
ArticleEmbedded         → EventLinkerV2
EventCreated            → LifecycleManager.handleEventCreated
ArticleLinkedToEvent    → LifecycleManager.handleArticleLinked
EventUpdateTriggered    → VersioningHandler
EventVersionCommitted   → ClaimQuoteExtractor
ClaimGraphBuilt         → OverviewGenerator
OverviewGenerated       → TopicAssigner
OverviewGenerated       → BiasProfiler
TopicHeatmapBuilt       → SubEventBuilder
EventPublished          → AiPipeline.onPublished

Extras (infraestructura):
EventPublished          → cache invalidation subscriber
ArticleLinkedToEvent    → cache invalidation subscriber
(varios)                → metrics subscribers (contadores)
```

**Observación clave**: Todos los handlers se ejecutan **secuencialmente** dentro de un mismo `publish()`. No hay paralelismo. Si un handler falla, se loguea el error y se continúa con el siguiente (`try-catch` por handler).

---

## 2. Base de datos

### 2.1 Schema Prisma — Modelos (14 tablas)

| Modelo | Tabla | Propósito | Relaciones clave |
|---|---|---|---|
| `Media` | `media` | Medio de comunicación (fuente) | → articles[] |
| `Article` | `article` | Artículo individual | → media, eventArticles[], quotes[] |
| `Event` | `event` | Evento noticioso (cluster) | → eventArticles[], versions[], claims[], self-ref canonicalEvent |
| `EventArticle` | `event_article` | Relación N:N evento-artículo | → event, article |
| `EventVersion` | `event_version` | Snapshot inmutable de versión | → event, claims[] |
| `Claim` | `claim` | Afirmación extraída | → event, version, quotes[] |
| `Quote` | `quote` | Cita textual de soporte | → claim, article |
| `BiasLabel` | `bias_label` | Etiqueta de sesgo | → event_id, version_id, media_id?, article_id? |
| `TopicAssignment` | `topic_assignment` | Asignación de tópico | → event_id, version_id, article_id |
| `MediaProfile` | `media_profile` | Perfil acumulado de sesgo del medio | PK: media_id |
| `AuditLog` | `audit_log` | Log de auditoría (append-only) | entity_type + entity_id |

### 2.2 Enums

| Enum | Valores |
|---|---|
| `ArticleStatus` | DISCOVERED, NORMALIZED, POLICY_OK, POLICY_BLOCKED |
| `BlockedReason` | NOT_ALLOWLISTED, NOT_SPANISH, NO_EXTRACT, DUPLICATE_URL, PARSE_FAIL |
| `EventState` | DETECTED, PENDING_PUBLISH, PUBLISHED, UPDATING, DORMANT, CLOSED |
| `GateStatus` | PASS, FAIL, NA |
| `ClaimType` | FACT, ALLEGATION, FORECAST, OPINION, QUANT |
| `ClaimStatus` | SUPPORTED, DISPUTED, INSUFFICIENT |
| `QuoteStrength` | WEAK, MEDIUM, STRONG |
| `QuoteRole` | EVIDENCE, ATTRIBUTION, CONTEXT |
| `BiasScope` | MEDIA_LEVEL, ARTICLE_LEVEL |
| `AuditEntityType` | ARTICLE, EVENT, EVENT_VERSION, MERGE, SUB_EVENT, OVERVIEW, CLAIM, BIAS, TOPIC |

### 2.3 Diagrama E-R simplificado

```
Media 1───* Article
                │
                ├───* EventArticle *───1 Event
                │                        │
                └───* Quote              ├───* EventVersion
                       │                 │         │
                       *                 │         ├───* Claim ───* Quote
                       │                 │         │
                       Claim ────────────┘         └── packetJson (ai_overview, key_facts, etc.)

Event ───── canonicalEventId ───── Event (self-ref para merges)

Event ───* BiasLabel
Event ───* TopicAssignment
Media ──── MediaProfile
AuditLog (independiente, referencia por entity_type + entity_id)
```

### 2.4 Transiciones de estado

#### Article lifecycle:
```
DISCOVERED → NORMALIZED → POLICY_OK    (happy path)
                        → POLICY_BLOCKED (fin, con blockedReason)
```

#### Event lifecycle:
```
(nuevo) → DETECTED → PENDING_PUBLISH → PUBLISHED → CLOSED (inactividad 7d)
                                           │
                                           └── puede recibir artículos mientras PUBLISHED
                                               cada artículo dispara EventUpdateTriggered
                                               → nuevo version → claims → overview

UPDATING y DORMANT están definidos en el enum pero NO se usan actualmente en el código.
```

### 2.5 Campos importantes en `packetJson` (EventVersion)

El campo `packetJson` de `EventVersion` es un JSON flexible que acumula datos del pipeline:

```json
{
  "ai_overview": {
    "what_happened": ["..."],
    "context": ["..."],
    "in_dispute": ["..."],
    "confidence_label": "Alta|Media|Baja|No concluyente",
    "why": "...",
    "fuentes": ["..."]
  },
  "ai_teaser": "...",
  "key_facts_count": 5,
  "overview_mode": "llm|heuristic|text_fallback",
  "claims_hash": "sha256...",
  "gate_status_reason": ["..."]
}
```

**Riesgo**: `packetJson` no tiene schema formal — es `Json` en Prisma. El código confía en convención. No hay validación Zod ni similar al leer/escribir.

### 2.6 Índices existentes

```sql
event: state, publishedAt DESC, tLast DESC
event_article: eventId, articleId (+ PK compuesto)
event_version: (eventId, versionIndex) UNIQUE
claim: (eventId, versionId)
quote: claimId, articleId
bias_label: (eventId, versionId), (mediaId, eventId), articleId
topic_assignment: (eventId, versionId), topicKey, articleId
audit_log: entityId, occurredAt DESC
article: url UNIQUE
media: mediaKey UNIQUE
```

**Ausentes notables**: No hay índice en `article.mediaId`, ni en `article.status`, ni en `event.canonicalEventId`. El campo `embeddingVec` (JSON array de 256 floats) no tiene búsqueda vectorial — la comparación se hace cargando TODOS los vectores de un evento en memoria.

---

## 3. Scheduler y ciclo de vida

### 3.1 Scheduler: implementación

El scheduler es **in-memory** (`Map<string, ScheduledJob>`). No persiste en DB ni en Redis.

```typescript
// Core loop (server.ts):
setInterval(async () => {
  await scheduler.runDueJobs();
  // Re-registrar jobs recurrentes si faltan
}, SCHEDULER_TICK_MS);  // default: 30s
```

**Implicación crítica**: Si el proceso se reinicia, TODOS los jobs pendientes se pierden. La mitigación es el "rehydration" al startup:

```typescript
// server.ts startup:
const pending = await eventRepo.findPendingPublish();
// → ejecuta publish para los que ya pasaron su publishAt
// → re-registra los que aún no
```

Solo rehydrata `PENDING_PUBLISH` events. No rehydrata refresh jobs, close checks, ni scrape ticks — se re-registran como nuevos jobs al inicio.

### 3.2 Jobs recurrentes

| Job key | Intervalo default | Qué hace |
|---|---|---|
| `scrape:tick` | 15 min | `ScrapeOrchestrator.run()` — scrape todos los medios allowlisted |
| `lifecycle:close` | 6 horas | `runCloseCheck()` — cierra eventos sin actividad en 7 días |
| `lifecycle:scheduleRefreshes` | 30 min | Registra `refresh:EVENT_ID` para cada evento activo |
| `publish:EVENT_ID` | One-shot (5 min delay) | `executePublish()` — PENDING_PUBLISH → PUBLISHED |
| `refresh:EVENT_ID:SLOT` | 30 min slots | `executeRefresh()` — dispara EventUpdateTriggered |

### 3.3 Scrape lock

```typescript
// scrapeLock.tryAcquire(traceId) — evita ejecuciones concurrentes
// Si ya hay un scrape corriendo, el siguiente tick se salta
// Timeout: SCRAPE_TIMEOUT_MS (default 60s)
```

### 3.4 LifecycleManager — state machine

```
handleEventCreated():
  1. event.state = PENDING_PUBLISH
  2. scheduler.register(publish:ID, now + 5min)
  3. audit: PUBLISH_SCHEDULED
  4. publish: EventPublishScheduled

handleArticleLinked():
  1. if LINKED_EXISTING → event.tLast = now
  2. publish: EventUpdateTriggered

executePublish():
  1. Skip si CLOSED, PUBLISHED, o publishAt en el futuro
  2. event.state = PUBLISHED, publishedAt = now
  3. audit: PUBLISHED
  4. publish: EventPublished

executeRefresh():
  1. Skip si CLOSED
  2. publish: EventUpdateTriggered (trigger: REFRESH_JOB)

runCloseCheck():
  1. Busca eventos donde tLast < (now - 7d)
  2. event.state = CLOSED, closedAt = now
  3. audit: CLOSED
  4. publish: EventClosed
```

**Nota**: Los estados `UPDATING` y `DORMANT` del enum `EventState` NO se usan en ningún código actual. Son dead code en el schema.

---

## 4. Lógica del feed

### 4.1 Endpoint público

```
GET /v1/feed?cursor=BASE64
```

### 4.2 Flujo de construcción del feed

```
1. Si page 1 (sin cursor) y RankingService disponible → rankedFeed
   - Fetch top 60 eventos PUBLISHED
   - Calcula score por evento
   - Ordena por score descendente
   - Retorna top 20

2. Si page 2+ (con cursor) → chronologicalFeed
   - Cursor = base64("publishedAt|eventId")
   - Over-fetch 60 rows (3x PAGE_SIZE) para compensar gate filtering
   - Ordena por publishedAt DESC
```

### 4.3 Publish gate (anti-hallucination)

Antes de incluir un evento en el feed, pasa por `evaluatePublishGate()`:

```
Gate Multi (sources >= 2):
  - total_usable_text_len >= 1200
  - overview_status != 'failed'
  - key_facts_count >= GATE_KEY_FACTS_MIN (default 0)

Gate Single (sources == 1):
  - total_usable_text_len >= 800
  - overview_status != 'failed'

Resultado:
  eligible=true  → aparece en feed
  eligible=false → se filtra, se loguea razón
```

**Kill switch**: `PUBLISH_GATE_ENABLED=0` bypasea todo.

**Punto sutil**: overview_status 'pending' NO bloquea. Solo 'failed' bloquea. Esto permite que eventos aparezcan en feed antes de tener overview completo, con un fallback determinístico.

### 4.4 Fallback overview

Para eventos elegibles pero sin overview listo:

```typescript
buildFeedFallbackOverview(headline, sources, status):
  what_happened: [headline, "Fuentes: X, Y, Z.", "Resumen en proceso."]
  context: []
  in_dispute: []
  confidence_label: "Pendiente"
```

### 4.5 Evidence level

```
computeEvidenceLevel(uniqueSources, totalUsableTextLen):
  HIGH:   sources >= 3 AND text >= 3000
  MEDIUM: sources >= 2 AND text >= 1200
  LOW:    sources >= 1 AND text >= 400
  NONE:   everything else
```

### 4.6 Ranking formula

```
score(e) = 0.40*I + 0.22*M + 0.18*R + 0.08*Q + 0.06*T - 0.06*J

I = Importance:  sigmoid( log(1+n_arts_eff) * log(1+n_unique_media) )
    n_arts_eff = Σ min(articles_per_media, 3)  ← cap por medio
    Penalidad -0.05 si un medio tiene >70% de artículos

M = Momentum:   sigmoid( Δartículos_6h + 2 * Δmedios_únicos_6h )
    Excluye artículos con junk_score >= 0.45

R = Recency:    exp(-0.693 * age_ms / 12h)  ← half-life 12 horas

Q = Quality:    min(1, claims_SUPPORTED / max(1, claims_total))

T = Topic:      boost por hot topics (configurable)

J = Junk:       avg(junk_score) de todos los artículos
    >= 0.75 → artículo excluido del feed completamente
    0.45-0.75 → penaliza ranking, no cuenta en momentum
    < 0.45 → normal

Tie-breakers: unique_media DESC → updates_6h DESC → publishedAt DESC
```

### 4.7 Junk scorer

Heurístico basado en regex (NO ML):

```
Señales:
  - URL patterns (patrocinado, tienda, utm_source, etc.)     peso 0.35
  - Author/section (contenido patrocinado, comercial)         peso 0.45
  - Title keywords (oferta, descuento, gratis, top 10, etc.)  peso 0.30
  - SEO spam (multiple links, click-bait patterns)            peso 0.20
  - Snippet < 100 chars                                       peso 0.10

Score = sum(señales activadas), clamped a [0, 1]
```

---

## 5. Overview y LLM

### 5.1 LLM Client

```typescript
// core/llm/index.ts
class LlmClient {
  isAvailable(): boolean  // → true si ANTHROPIC_API_KEY está en env
  completeJson(system, user, schema): Promise<T>
}
```

Si `ANTHROPIC_API_KEY` no está configurada, **todo el sistema opera en modo heurístico** sin LLM. El código verifica `llmClient.isAvailable()` al startup y pasa `null` a los servicios si no está disponible.

### 5.2 Pipeline de overview — 3 paths

```
Path A: LLM mode (llmClient disponible)
  1. extractFacts() — heurístico (NO LLM) → FactsPacket
  2. completeJson(OVERVIEW_WRITER_SYSTEM, facts) → ai_overview
  3. validateOverviewContent() — gate anti-hallucination
  4. Si gate falla → Path B

Path B: Heuristic fallback (sin LLM o LLM falla)
  1. Organiza claims por status y tipo:
     - what_happened: SUPPORTED + (FACT|QUANT)
     - context: SUPPORTED + (ALLEGATION|OPINION)
     - in_dispute: DISPUTED claims
     - nota: INSUFFICIENT claims
  2. Gate: ≥2 SUPPORTED claims + bullets con citas
  3. Si insuficiente → Path C

Path C: Text fallback
  1. Extrae oraciones factuales del texto de artículos
  2. Clasifica en what_happened vs context via regex
  3. Mínimo 800 chars
```

### 5.3 Anti-hallucination gates

```
validateOverviewEvidence():
  - ≥ 2 fuentes distintas (media keys)
  - ≥ 2 citas totales referenciables
  → Si falla: buildInsufficientOverview() con confidence='No concluyente'

validateOverviewContent():
  - what_happened no vacío
  - context no vacío
  - in_dispute no vacío
  → Si falla: caer a heurístico
```

### 5.4 Claims extraction

`ClaimQuoteExtractor` — mayormente heurístico:

```
1. Divide texto en oraciones (respeta abreviaturas)
2. Clasifica cada oración:
   FACT:       afirmación verificable
   QUANT:      números, porcentajes, cifras
   ALLEGATION: atribuido a fuente ("según X", "declaró")
   OPINION:    subjetivo, valorativo
   FORECAST:   predicción futura

3. Busca quotes en texto original (exact/fuzzy match)
4. Clasifica strength de quote:
   STRONG: números, atribución directa
   MEDIUM: contexto o soporte parcial
   WEAK:   hedging, sin especificidad

5. Detección de contradicciones:
   - Números conflictivos
   - Patrones de negación
   → status = DISPUTED

6. Status final:
   SUPPORTED:    ≥1 STRONG quote OR ≥2 MEDIUM (cross-media)
   DISPUTED:     contradicho
   INSUFFICIENT: no alcanza SUPPORTED
```

### 5.5 AI enrichment (post-publish)

```typescript
// ai-enrichment.ts
EventPublished → AiPipeline.onPublished:
  1. Obtiene última versión del evento
  2. Si ya tiene ai_run_version_id → skip (idempotente)
  3. Ejecuta claims extraction
  4. Ejecuta overview generation
```

---

## 6. Observabilidad

### 6.1 Logging

- **Librería**: Pino (structured JSON logging)
- **Trace middleware**: Cada request HTTP recibe `trace_id` via header o auto-generado (ULID)
- **Patrón**: Todos los handlers loguean inicio, fin, errores, y decisiones clave

Logs clave del pipeline:
```
event_published          — EventBus dispatch
handler_error            — Error en handler (catch + continue)
linker_decision          — Decisión de vinculación con score, gates, signals
feed_publish_gate_filtered — Eventos filtrados del feed con razones
scheduler_job_executed   — Job completado con duración
scrape_tick_*            — Inicio/fin de scraping
```

### 6.2 Audit trail

Tabla `audit_log` — append-only con:
- `entity_type`: ARTICLE, EVENT, EVENT_VERSION, MERGE, etc.
- `action`: DISCOVERED, NORMALIZED, LINKED_TO_EVENT, PUBLISH_SCHEDULED, PUBLISHED, CLOSED, HANDLER_ERROR, etc.
- `trace_id`: Para correlacionar toda la cadena
- `data`: JSON libre con detalles de la acción

### 6.3 Métricas in-memory

```typescript
// core/metrics/subscribers.ts
// Contadores registrados via EventBus subscribers:
articles_discovered_total
articles_normalized_total
articles_policy_ok_total
articles_policy_blocked_total
articles_embedded_total
articles_linked_total
events_created_total
events_published_total
events_closed_total
```

**Endpoint**: `GET /v1/metrics` — retorna JSON con counters.

**Limitación**: Los counters se resetean con cada restart. No hay Prometheus, no hay time-series, no hay histogramas de latencia.

### 6.4 Debug endpoints (6 rutas)

| Ruta | Archivo | Propósito |
|---|---|---|
| `GET /v1/debug/scrape/status` | debug-scrape.ts | Estado del scraper, último tick, artículos procesados |
| `GET /v1/debug/scheduler/status` | debug-scheduler.ts | Jobs en cola, último tick, forzar tick |
| `POST /v1/debug/scheduler/tick` | debug-scheduler.ts | Ejecutar scheduler tick manualmente |
| `GET /v1/debug/ai/status` | debug-ai.ts | Estado LLM, ejecutar AI en evento específico |
| `POST /v1/debug/ai/run/:eventId` | debug-ai.ts | Forzar AI enrichment en un evento |
| `GET /v1/debug/feed/raw` | debug-feed.ts | Feed sin gates ni ranking (raw DB rows) |
| `GET /v1/debug/quality/snapshot` | debug-quality.ts | Snapshot de métricas de calidad del sistema |
| `GET /v1/debug/linker/diagnostics` | debug-linker.ts | Diagnóstico de linking: decisiones, splits, gates |

**Nota de seguridad**: Los endpoints debug NO tienen autenticación. Están expuestos a cualquiera que conozca la URL. En producción esto es un riesgo.

---

## 7. Deuda técnica

### 7.1 Crítica (afecta correctitud o disponibilidad)

| # | Deuda | Ubicación | Impacto |
|---|---|---|---|
| D1 | **Scheduler in-memory** — pierde todos los jobs al reiniciar | `core/scheduler/scheduler.ts` | Publish jobs perdidos, scrape deja de correr hasta re-register. Mitigación parcial: rehydration al startup, pero solo para PENDING_PUBLISH. |
| D2 | **EventBus in-memory** — no hay retry, no hay DLQ | `core/event_bus/dispatcher.ts` | Si un handler falla, el evento se pierde para ese handler. Se loguea pero no se re-intenta. Pipeline se interrumpe silenciosamente. |
| D3 | **packetJson sin schema** — JSON tipado como `any` | `event_version.packet_json` | Lectura con casts `as any` por todo el código. Un campo mal nombrado o ausente causa bugs silenciosos. |
| D4 | **Vectores en JSON** — no hay búsqueda vectorial | `article.embedding_vec` (Json) | Para comparar un artículo vs un evento, se cargan TODOS los vectores del evento en memoria, se computan centroides, y se calcula coseno. No escala con eventos grandes (>500 artículos se filtran como "mega-event"). |
| D5 | **Estados muertos en EventState** | Schema Prisma | `UPDATING` y `DORMANT` están definidos pero ningún código los usa. Confusión para desarrolladores. |

### 7.2 Alta (afecta mantenibilidad o escalabilidad)

| # | Deuda | Ubicación | Impacto |
|---|---|---|---|
| D6 | **DI manual en server.ts** — 224 líneas de wiring | `server.ts` | Cualquier cambio de dependencia requiere editar server.ts. No hay contenedor IoC. |
| D7 | **Sin migraciones Prisma** | `db/prisma/` | Solo existe `schema.prisma`, no hay carpeta `migrations/`. Cambios de schema requieren `prisma db push` (destructivo en prod). |
| D8 | **Scraping síncrono por medio** | `scrape-orchestrator.ts` | Cada medio se procesa secuencialmente en un solo tick. Con N medios, el scrape tick puede durar N × timeout. |
| D9 | **Cache sin namespacing** | `core/cache/cache.ts` | Un solo Cache global para feed y event-detail. Invalidación por evento invalida todo el cache del feed. |
| D10 | **Métricas no persistentes** | `core/metrics/` | Counters in-memory se pierden al reiniciar. No hay integración con Prometheus/Grafana. |

### 7.3 Media (molestias o mejoras diferidas)

| # | Deuda | Ubicación | Impacto |
|---|---|---|---|
| D11 | **Módulos versions/ y events/ separados sin razón clara** | `modules/versions/` vs `modules/events/` | `VersionRepository` está en `versions/`, `EventRepository` en `events/`. Ambos operan sobre la misma entidad conceptual. |
| D12 | **Hash embeddings determinísticos** | `embedding/service/hash-vector.ts` | No son embeddings semánticos reales. Capturan co-ocurrencia de n-grams, no significado. Suficiente para noticias similares con vocabulario compartido, pero falla con paráfrasis. |
| D13 | **Topic taxonomy hardcoded** | `constants/topics_v0_1.json` | Lista cerrada de tópicos. No hay mecanismo de actualización sin deploy. |
| D14 | **Bias profiler basado en regex** | `bias/service/bias-profiler.ts` | Detección de sesgo por patrones de texto, no por análisis semántico. Precisión limitada. |
| D15 | **No hay tests de integración con DB** | `*.test.ts` | Todos los tests usan mocks. Los tests que necesitan DB (`db.test.ts`) se skipean si no hay PostgreSQL. |

---

## 8. Riesgos sistémicos

### 8.1 Single point of failure: el proceso Node.js

Todo corre en un solo proceso:
- HTTP server
- EventBus (handlers síncronos)
- Scheduler (setInterval)
- Scraper
- LLM calls

**Si el proceso muere**:
- Se pierden todos los scheduled jobs
- Se pierden los counters de métricas
- Se pierde el cache
- Se pierde el scrape lock state
- Se pierden los cooldowns del split detector

**Si el proceso se bloquea** (e.g., LLM call que tarda 30s):
- El scheduler tick se atrasa
- Las requests HTTP esperan
- No hay health check que reinicie el proceso

### 8.2 Cascada de handlers en EventBus

Los handlers se ejecutan secuencialmente en `publish()`:
```
ArticleEmbedded → EventLinkerV2 (puede tardar 500ms+)
  → dentro de linker: publish(ArticleLinkedToEvent)
    → LifecycleManager.handleArticleLinked
      → publish(EventUpdateTriggered)
        → VersioningHandler
          → publish(EventVersionCommitted)
            → ClaimQuoteExtractor (puede tardar 2s+)
              → publish(ClaimGraphBuilt)
                → OverviewGenerator (LLM: 5-15s)
                  → publish(OverviewGenerated)
                    → TopicAssigner
                    → BiasProfiler
                      → publish(TopicHeatmapBuilt)
                        → SubEventBuilder
```

**Un solo artículo puede disparar una cascada de 10+ handlers síncronos**. Si el LLM tarda 15s, todo el pipeline está bloqueado 15s para ese artículo. Otros artículos en cola esperan.

### 8.3 Memory pressure por vectores

Para cada decisión de linking:
1. Se buscan eventos en ventana de 72h (fallback 7d)
2. Para cada evento candidato, se cargan TODOS sus artículos con vectores
3. Se computan centroides en memoria

Con 100 eventos activos × 20 artículos × 256 floats = ~2MB por decisión de linking. Multiplicado por artículos concurrentes, puede causar pressure.

Mitigación parcial: mega-events (>500 artículos) se filtran, pero el umbral es alto.

### 8.4 Scrape sin rate limiting por dominio

`ScrapeOrchestrator` scrape todos los medios en un solo tick sin delay entre ellos. Si hay 20 medios, se lanzan 20 fetches en secuencia rápida. No hay:
- Rate limit por dominio
- Backoff por 429/503
- Rotación de User-Agent
- Respeto a `robots.txt`

### 8.5 Sin autenticación en endpoints debug

Los 6 endpoints debug (`/v1/debug/*`) no tienen autenticación:
- `/v1/debug/scheduler/tick` permite forzar ejecución del scheduler
- `/v1/debug/ai/run/:eventId` permite forzar AI enrichment
- `/v1/debug/feed/raw` expone datos crudos del feed

En producción, cualquiera con acceso a la URL puede manipular el sistema.

### 8.6 LLM como dependencia frágil

Si la API de Anthropic tiene latencia alta o está caída:
- Las llamadas LLM bloquean el pipeline
- `withTimeout` existe para scraping pero NO para LLM calls
- No hay circuit breaker
- No hay fallback cache para respuestas LLM previas
- La facturación sigue corriendo si hay loops o retries

---

## 9. Métricas reales

> **Nota**: Este reporte se generó en un entorno sin PostgreSQL activo. Las siguientes métricas se derivan del análisis estático del código.

### 9.1 Métricas del código

| Métrica | Valor |
|---|---|
| Archivos fuente TypeScript | 136 |
| Archivos de test | 56 |
| Líneas totales de TypeScript | ~21,700 |
| Módulos de dominio | 19 |
| Módulos de infraestructura | 10 |
| Modelos Prisma | 14 (11 tablas + 3 lookup) |
| Enums | 10 |
| Rutas HTTP | 10 (4 públicas + 6 debug) |
| Eventos del bus | 13 tipos distintos |
| Suscripciones al bus | 15 (13 de dominio + 2 de infra) |
| Variables de entorno configurables | ~50+ |

### 9.2 Cobertura de tests

| Área | Tests | Tipo |
|---|---|---|
| EventBus | ~10 | Unit (in-memory) |
| Scheduler | ~8 | Unit (TestClock) |
| Embedding (hash-vector) | ~15 | Unit (determinístico) |
| Event linker (similarity) | ~20 | Unit (vectores hardcoded) |
| Pair scorer | ~20 | Unit (mock candidates) |
| Hard negative gates | ~15 | Unit (strings) |
| Split detector | ~10 | Unit (mock repos) |
| Claims extractor | ~15 | Unit (text parsing) |
| Overview generator | ~10 | Unit (mock claims) |
| Junk scorer | ~10 | Unit (URL/title patterns) |
| Event scorer | ~15 | Unit (mock events) |
| Ranking service | ~8 | Unit (mock scored events) |
| Feed service | ~10 | Unit (mock repos) |
| Text sanitizer | ~20 | Unit (text normalization) |
| API routes | ~30 | Integration (Fastify inject, mock repos) |
| Quality metrics | ~10 | Unit |
| **Total** | **~565** | **0 fallos** |

**Nota**: No hay tests de integración reales con DB. `db.test.ts` se skipea sin PostgreSQL. Todo es mocking.

### 9.3 Thresholds y constantes del sistema

| Parámetro | Valor default | Env var |
|---|---|---|
| Score auto-link | 0.45 | `EVENT_LINKER_THETA_AUTO` |
| Score maybe-link | 0.30 | `EVENT_LINKER_THETA_MAYBE` |
| Peso embedding | 0.55 | `EVENT_LINKER_W_EMBEDDING` |
| Peso entity | 0.25 | `EVENT_LINKER_W_ENTITY` |
| Peso temporal | 0.20 | `EVENT_LINKER_W_TEMPORAL` |
| Ventana primaria | 72h | `EVENT_LINKER_WINDOW_PRIMARY_MS` |
| Ventana fallback | 7d | `EVENT_LINKER_WINDOW_FALLBACK_MS` |
| Gate entity (auto) | 0.05 Jaccard | `EVENT_LINKER_AUTO_MIN_ENTITY_JACCARD` |
| Gate entity (maybe) | 0.01 Jaccard | `EVENT_LINKER_MAYBE_MIN_ENTITY_JACCARD` |
| Señales fuertes requeridas | 2 | `EVENT_LINKER_AUTO_REQUIRES_SIGNALS` |
| Split min artículos | 5 | `EVENT_LINKER_SPLIT_MIN_ARTICLES` |
| Split cohesión threshold | 0.22 | `EVENT_LINKER_SPLIT_COHESION_THRESHOLD` |
| Publish delay | 5 min | `PUBLISH_DELAY_MS` |
| Scrape interval | 15 min | `SCRAPE_INTERVAL_MS` |
| Close check | 6 horas | `CLOSE_CHECK_INTERVAL_MS` |
| Refresh interval | 30 min | `REFRESH_INTERVAL_MS` |
| Scheduler tick | 30s | `SCHEDULER_TICK_MS` |
| Text min len (body) | 800 chars | hardcoded |
| Text min len (meta) | 100 chars | hardcoded |
| Gate multi sources | 2 | `GATE_MULTI_SOURCES` |
| Gate multi text | 1200 | `GATE_MULTI_TEXT` |
| Gate single text | 800 | `GATE_SINGLE_TEXT` |
| Rate limit | 60 req/min | `RATE_LIMIT_MAX` |
| Cache TTL | 30s | `CACHE_DEFAULT_TTL_MS` |
| Cache max entries | 500 | `CACHE_MAX_ENTRIES` |
| Ranking half-life | 12h | hardcoded |
| Junk exclude | >= 0.75 | hardcoded |
| Junk penalty | >= 0.45 | hardcoded |

---

## 10. Resumen ejecutivo

### Lo que funciona bien

1. **Pipeline event-driven coherente**: El flujo ArticleDiscovered → ... → OverviewGenerated es trazable y auditable. Cada paso tiene audit log con trace_id.

2. **Degradación graciosa del LLM**: El sistema funciona 100% sin Anthropic API key. Claims extraction es heurístico. Overview tiene 3 niveles de fallback. Esto es inusual y valioso.

3. **Event linking v2.1 sofisticado**: Scoring compuesto con 3 señales, hard blocks, hard negative gates, two-step decision, y split detector post-merge. Feature-flagged por env vars.

4. **Publish gate anti-hallucination**: El feed no muestra eventos sin evidencia suficiente. Gate configurable con kill switch.

5. **Cobertura de tests alta**: 565 tests, 0 fallos. Cada módulo tiene tests unitarios.

6. **Configurabilidad**: ~50 env vars permiten tunear thresholds sin re-deploy.

### Lo que preocupa

1. **Monolito single-process**: Todo — HTTP, scraping, LLM calls, event processing, scheduling — corre en un solo proceso Node.js. Un LLM call lento de 15s bloquea todo el pipeline.

2. **Sin persistencia de estado efímero**: Scheduler, cache, métricas, cooldowns — todo in-memory. Un restart pierde todo. La rehydration solo cubre PENDING_PUBLISH events.

3. **Cascada síncrona en EventBus**: Un artículo puede disparar 10+ handlers anidados. No hay backpressure, no hay cola, no hay paralelismo. El artículo N+1 espera a que el N complete toda su cascada.

4. **Embeddings no semánticos**: Los hash vectors capturan n-grams, no significado. Dos artículos que describen el mismo evento con palabras distintas pueden tener baja similitud. Esto limita el recall del linker.

5. **packetJson sin schema**: El campo más importante del sistema (contiene el overview, facts, gate status) es un `Json` sin validación. Cualquier typo pasa silenciosamente.

6. **Debug endpoints sin auth**: 6 endpoints que pueden manipular el sistema (forzar scheduler, ejecutar AI, ver datos crudos) están completamente abiertos.

7. **Sin migraciones de DB**: No hay historial de cambios de schema. `prisma db push` es el único mecanismo, que puede ser destructivo en producción.

### Veredicto

FUNDACION es un **MVP funcional y bien estructurado** para su escala actual (puñado de medios colombianos, decenas de eventos activos). La arquitectura event-driven con audit trail es correcta conceptualmente. La degradación graciosa del LLM y el publish gate son decisiones maduras.

**No está preparado para producción seria** sin abordar: persistencia de scheduler/estado, paralelismo del pipeline, seguridad de endpoints debug, y migraciones de DB. El salto de MVP a producción requiere infraestructura externa (queue, Redis, Prometheus) que actualmente se simula con primitivas in-memory.

La prioridad de mejora, en orden de impacto/esfuerzo, sería:
1. Proteger endpoints debug (autenticación)
2. Persistir scheduler en DB (baja complejidad, alta resiliencia)
3. Hacer el EventBus asíncrono con cola (desacoplar pipeline)
4. Schema validation para packetJson (Zod)
5. Migraciones Prisma
6. Embeddings semánticos reales (si el recall del linker es insuficiente)

---

*Fin del reporte. Generado por auditoría automatizada sobre la base de código en branch `claude/diagnose-feed-events-JlLDA`.*

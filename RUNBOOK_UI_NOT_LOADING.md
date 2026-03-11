# Runbook: UI Not Loading / Feed Empty

Checklist determinista para diagnosticar por qué la UI muestra vacío o no carga datos.

## 1. Checklist "5 comandos"

Copiar y pegar estos 5 comandos en orden. El backend debe estar corriendo (`npm run dev`).

```bash
BASE=http://localhost:${PORT:-3000}

# 1) Health — debe responder { ok: true }
curl -sf "$BASE/v1/health" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.ok?'PASS: health ok':'FAIL: health not ok',JSON.stringify(j))})"

# 2) Tabs — debe tener al menos 1 tab
curl -sf "$BASE/v1/tabs" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log((j.items||[]).length>0?'PASS:':'FAIL:','tabs='+((j.items||[]).length),JSON.stringify(j.items))})"

# 3) Feed — count + muestra primer item
curl -sf "$BASE/v1/feed?tab=global" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const items=j.items||[];console.log(items.length>0?'PASS:':'FAIL:','feed_items='+items.length);if(items[0])console.log('  sample:',JSON.stringify({event_id:items[0].event_id,headline:items[0].headline,overview_status:items[0].overview_status,evidence_level:items[0].evidence_level,sources:(items[0].sources||[]).length},null,2))})"

# 4) Scrape — resumen por media
curl -sf -X POST "$BASE/v1/debug/scrape/run" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.ok?'PASS:':'FAIL:','discovered='+j.discovered,'skipped='+(j.skipped??0));(j.media_results||[]).forEach(m=>console.log(' ',m.media_key,'ok='+m.ok,'discovered='+m.discovered,'skipped='+m.skipped,'fetch_fail='+m.fetch_fail,'ms='+m.duration_ms))})"

# 5) Gate diagnostics
curl -sf "$BASE/v1/debug/feed/stats" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const t=j.totals;console.log('published_total='+t.published_total,'feed_returned='+t.feed_returned_count,'gate_filtered='+t.gate_filtered_count);(j.top_filter_reasons||[]).forEach(r=>console.log('  reason:',r.reason,'count='+r.count));if(j.sample_fail)console.log('  sample_fail:',JSON.stringify({id:j.sample_fail.event_id,reasons:j.sample_fail.gate_reasons,evidence:j.sample_fail.evidence_level}))})"
```

O usa el atajo:

```bash
npm run debug:ui
```

---

## 2. Arbol de decision

```
Backend arriba?
  curl /v1/health → { ok: true }
    │
    ├── NO → Backend no esta corriendo.
    │        Fix: npm run dev (o verificar PORT, DATABASE_URL)
    │
    └── SI
         │
         Feed tiene items?
         curl /v1/feed?tab=global → items.length
           │
           ├── items > 0 → Feed funciona. Problema es UI. → Ir a [2.4]
           │
           └── items = 0 → Feed vacio. Mirar debug/feed/stats → Ir a [2.1]


[2.1] Feed vacio — diagnosticar con gate stats
      curl /v1/debug/feed/stats

      ┌── published_total = 0?
      │     No hay eventos PUBLISHED. → Ir a [2.2]
      │
      └── published_total > 0 pero gate_filtered_count > 0?
            El gate esta filtrando eventos. → Ir a [2.3]


[2.2] No hay eventos publicados (published_total = 0)
      curl -X POST /v1/debug/scrape/run

      ┌── discovered = 0?
      │     ├── Todos los media ok=false?
      │     │     → Problema de red o URLs cambiaron.
      │     │       Verificar: curl -I https://www.eltiempo.com
      │     │       Verificar scrapers en src/modules/ingestion/scrapers/
      │     │
      │     └── fetch_fail alto en algun media?
      │           → Paywall, timeout, o pagina cambio estructura HTML.
      │             Verificar: PER_MEDIA_TIMEOUT_MS (default 20000)
      │
      └── discovered > 0 pero no se publican?
            → Pipeline no llego a PUBLISHED. Verificar:
              1. Scheduler tick: SCHEDULER_TICK_MS (default 30000)
              2. Publish delay: PUBLISH_DELAY_MS (default 300000 = 5 min)
              3. Logs: buscar "lifecycle_publish" o "scheduler_job_stub"
              4. DB: SELECT state, COUNT(*) FROM event GROUP BY state;


[2.3] Gate filtrando eventos (gate_filtered_count > 0)
      Revisar top_filter_reasons:

      Reason                    Causa                              Solucion
      ──────────────────────────────────────────────────────────────────────
      OVERVIEW_FAILED           Pipeline de overview fallo         Revisar logs "overview_generator_error"
                                                                   Reejecutar: POST /v1/debug/ai/run?event_id=X&force=1
      NO_SOURCES                Evento sin articulos usables       Verificar scrape + policy guard
      TEXT_TOO_SHORT            Texto total < 800 chars            Verificar text extraction de articulos
      KEY_FACTS_TOO_FEW         key_facts < GATE_KEY_FACTS_MIN    Bajar GATE_KEY_FACTS_MIN=0 (default)

      Kill switch temporal:
        PUBLISH_GATE_ENABLED=0 npm run dev
        → Desactiva el gate. Todos los eventos PUBLISHED pasan al feed.


[2.4] Feed funciona pero UI muestra vacio
      Verificar en orden:

      a) CORS
         curl -I http://localhost:3000/v1/feed
         → Debe incluir: access-control-allow-origin: *
         Si falta: verificar que @fastify/cors esta registrado en server.ts

      b) Base URL en frontend
         → El cliente usa EXPO_PUBLIC_API_BASE_URL (default: http://localhost:3000)
         → Verificar que no apunte a un puerto o host incorrecto:
           grep -r EXPO_PUBLIC_API_BASE_URL apps/client/

      c) Network errors en consola del browser
         → Abrir DevTools > Network > filtrar por /v1/
         → Buscar 404, 500, CORS errors, o net::ERR_CONNECTION_REFUSED

      d) Tipos TS mismatch (overview_status)
         → El backend puede enviar overview_status: 'pending' | 'unavailable' | 'ready' | 'failed'
         → El frontend (apps/client/src/lib/types.ts) debe reconocer los mismos valores
         → Si el frontend filtra overview_status !== 'ready', los items con fallback no se muestran

      e) Respuesta vacia pero items existen
         → Verificar que el tab querystring sea correcto: ?tab=global
         → Verificar cursor encoding si paginando
```

---

## 3. Golden Path — demo local

Secuencia completa para verificar que el sistema funciona end-to-end.

### Prerequisitos

```bash
cp .env.example .env
# Editar DATABASE_URL si no es el default
npm run db:migrate
npm run db:seed
```

### Ejecucion

```bash
# Terminal 1: backend
npm run dev

# Terminal 2: diagnostico
BASE=http://localhost:${PORT:-3000}

# Paso 1: verificar health
curl -sf "$BASE/v1/health"
# Esperado: {"ok":true,"time":"..."}

# Paso 2: trigger scrape
curl -sf -X POST "$BASE/v1/debug/scrape/run" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).discovered,'articles discovered'))"
# Esperado: N articles discovered (N > 0)

# Paso 3: esperar publish tick (default PUBLISH_DELAY_MS=300000 = 5 min)
# Para desarrollo rapido, iniciar con:
#   PUBLISH_DELAY_MS=30000 SCHEDULER_TICK_MS=5000 npm run dev
# Luego esperar ~35 segundos.

# Paso 4: verificar feed
curl -sf "$BASE/v1/feed?tab=global" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.items.length,'feed items')})"
# Esperado: N feed items (N > 0)

# Paso 5: abrir un evento
EVENT_ID=$(curl -sf "$BASE/v1/feed?tab=global" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log((j.items[0]||{}).event_id||'')})")
[ -n "$EVENT_ID" ] && curl -sf "$BASE/v1/events/$EVENT_ID" | node -e "d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('headline:',j.headline);console.log('overview_status:',j.overview_status);console.log('sources:',j.sources?.length??0)})"
```

### Logs esperados (backend)

Buscar estas lineas en la salida del backend:

```
{"msg":"scrape_run_complete","total_discovered":N,...}    ← scrape exitoso
{"msg":"lifecycle_publish","event_id":"..."}               ← evento publicado
{"msg":"server_started","port":3000,...}                   ← backend arriba
```

Si no aparece `lifecycle_publish` despues de `PUBLISH_DELAY_MS`, verificar:
- `SCHEDULER_TICK_MS` no sea muy alto
- El evento alcanzo a pasar por embedding → linker → lifecycle
- Logs de error: buscar `"level":50` (ERROR)

---

## 4. Kill switches

Variables de entorno que desactivan subsistemas para aislar problemas.

| Variable | Valor | Efecto | Donde se documenta |
|---|---|---|---|
| `PUBLISH_GATE_ENABLED` | `0` | Bypass completo del gate de publicacion. Todo evento PUBLISHED aparece en feed. | `.env.example` linea 49 |
| `DISABLE_AUTO_LINK` | `1` | El linker nunca auto-vincula articulos a eventos existentes. Solo crea nuevos o marca "maybe". | `.env.example` linea 43 |
| `DEBUG_EVENT_LINKER` | `1` | Logs verbosos de cada decision del linker (scores, thresholds, entity overlap). | `.env.example` linea 46 |

### Uso para diagnostico rapido

```bash
# Caso: "no aparece nada en feed" — descartar que sea el gate
PUBLISH_GATE_ENABLED=0 npm run dev

# Caso: "demasiados eventos duplicados" — desactivar auto-link
DISABLE_AUTO_LINK=1 npm run dev

# Caso: "quiero ver por que el linker merge/separo articulos"
DEBUG_EVENT_LINKER=1 npm run dev
```

### Thresholds ajustables (no son kill switches pero afectan output)

| Variable | Default | Efecto |
|---|---|---|
| `THETA_AUTO_LINK` | `0.45` | Score minimo para auto-vincular articulo a evento |
| `THETA_MAYBE_LINK` | `0.30` | Score minimo para marcar como "maybe" |
| `GATE_MULTI_SOURCES` | `2` | Min fuentes para gate multi-fuente |
| `GATE_MULTI_TEXT` | `1200` | Min texto total para gate multi-fuente |
| `GATE_SINGLE_TEXT` | `800` | Min texto para gate mono-fuente |
| `GATE_KEY_FACTS_MIN` | `0` | Min key facts (0 = no bloquea) |
| `PUBLISH_DELAY_MS` | `300000` | Delay antes de publicar (5 min default) |
| `PER_MEDIA_TIMEOUT_MS` | `20000` | Timeout por media al scrapear |

Todos se documentan en `.env.example`.

---

## 5. Referencia rapida de endpoints debug

| Metodo | Endpoint | Descripcion |
|---|---|---|
| GET | `/v1/health` | Health check basico |
| GET | `/v1/tabs` | Lista de tabs disponibles |
| GET | `/v1/feed?tab=global` | Feed con paginacion |
| POST | `/v1/debug/scrape/run` | Ejecuta scrape manual |
| GET | `/v1/debug/scrape/status` | Estado del lock de scrape |
| GET | `/v1/debug/feed/stats` | Gate diagnostics: totals, top reasons, samples |
| POST | `/v1/debug/ai/run?event_id=X&force=1` | Re-ejecuta pipeline AI para un evento |
| GET | `/v1/metrics` | Metricas (Prometheus/JSON) |

# Fundación Client

Cross-platform mobile + web client built with Expo (React Native) + Expo Router.

## Prerequisites

- Node.js 20+
- npm or yarn
- For iOS: macOS + Xcode
- For Android: Android Studio + SDK
- For Web: Any modern browser

## Setup

```bash
cd apps/client
npm install
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:3000` | Backend API base URL |

Create a `.env` file or set the variable before running:

```bash
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000
```

## Running

```bash
# Start the dev server (all platforms)
npm start

# iOS
npm run ios

# Android
npm run android

# Web
npm run web
```

## Tests

```bash
npm test
```

## Architecture

```
apps/client/
├── app/                    # Expo Router file-based routes
│   ├── _layout.tsx         # Root Stack layout
│   ├── (tabs)/             # Bottom Tab navigator
│   │   ├── _layout.tsx     # Tab config
│   │   ├── index.tsx       # Para Ti (Feed)
│   │   ├── temas.tsx       # Temas
│   │   ├── historico.tsx   # Histórico
│   │   └── acerca.tsx      # Acerca de
│   └── event/
│       └── [eventId].tsx   # Event Detail + Media + Bias Modal
├── src/
│   ├── lib/
│   │   ├── api.ts          # API client with typed fetch wrappers
│   │   ├── cache.ts        # Client-side caching with timestamps
│   │   ├── history.ts      # Viewed events FIFO tracker (max 200)
│   │   ├── storage.ts      # Cross-platform storage abstraction
│   │   ├── theme.ts        # Colors, spacing, fonts
│   │   └── types.ts        # TypeScript types matching backend contracts
│   └── components/
│       ├── ConfidenceBadge.tsx
│       ├── EventCard.tsx
│       ├── MediaTabHeader.tsx
│       ├── OverviewBlock.tsx
│       ├── PillTag.tsx
│       ├── QuoteHighlightCard.tsx
│       ├── SkeletonCard.tsx
│       ├── SubEventTimeline.tsx
│       └── TopicHeatmapMini.tsx (+ HeatmapFull)
└── __tests__/
    ├── api.test.ts
    ├── cache.test.ts
    └── history.test.ts
```

## Screens

1. **Para Ti** — Vertical paging feed. Pull-to-refresh. Long-press action sheet. Offline cache fallback.
2. **Event Detail** — Full overview, heatmap preview, subevents, media tabs. Bias shown only in media tab.
3. **Media Tab** — Per-source articles, quote highlights, bias label with "¿Por qué?" rationale modal.
4. **Temas** — Server tabs + custom local topics CRUD.
5. **Histórico** — Segmented (Vistos / En desarrollo / Cerrados) from local viewed history.
6. **Acerca de** — Methodology accordions + system health check.

## Product Rules

- Feed shows ONLY objective overview. No bias in feed.
- Bias labels and rationale appear ONLY inside Event Detail → Media Tab → Rationale modal.
- No full article text stored or shown; only snippets/quotes from backend.
- Language: ES-CO. Bias = "patrón observado", may be "No concluyente".

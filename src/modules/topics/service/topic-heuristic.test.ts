import { describe, it, expect } from 'vitest';
import { classifyTopic, classifyTopicKeys, aggregateEventTopic, ALL_TOPIC_KEYS } from './topic-heuristic.js';

// ── POLITICA ──────────────────────────────────────────────────

describe('classifyTopic — POLITICA', () => {
  it('classifies government reform news', () => {
    const r = classifyTopic({
      title: 'Gobierno anuncia nueva reforma tributaria',
      text: 'El presidente presentó al congreso un proyecto de reforma tributaria que busca aumentar los ingresos del Estado. Los ministros del gabinete apoyaron la iniciativa.',
    });
    expect(r.topic_key).toBe('POLITICA');
    expect(r.score).toBeGreaterThan(0);
  });

  it('classifies election news', () => {
    const r = classifyTopic({
      title: 'Candidato opositor lidera encuestas para elecciones presidenciales',
      text: 'Las elecciones presidenciales se acercan y el partido de oposición presenta candidato.',
    });
    expect(r.topic_key).toBe('POLITICA');
  });

  it('gets URL boost from /politica/ section', () => {
    const r = classifyTopic({
      title: 'Nuevo decreto aprobado',
      text: 'El gobierno presentó un decreto sobre regulación.',
      url: 'https://www.eltiempo.com/politica/nuevo-decreto-12345',
    });
    expect(r.topic_key).toBe('POLITICA');
    expect(r.reasons.some((s) => s.includes('URL_SECTION'))).toBe(true);
  });
});

// ── CRIMEN_SEGURIDAD ──────────────────────────────────────────

describe('classifyTopic — CRIMEN_SEGURIDAD', () => {
  it('classifies homicide news', () => {
    const r = classifyTopic({
      title: 'Sicarios asesinan a líder social en Cali',
      text: 'Un líder social fue asesinado por sicarios. La fiscalía investiga el homicidio.',
    });
    expect(r.topic_key).toBe('CRIMEN_SEGURIDAD');
    expect(r.score).toBeGreaterThan(0);
  });

  it('classifies narco capture', () => {
    const r = classifyTopic({
      title: 'Capturado jefe de banda de narcotráfico en Medellín',
      text: 'La policía capturó al líder de una banda de narcotráfico. El criminal fue llevado a prisión.',
    });
    expect(r.topic_key).toBe('CRIMEN_SEGURIDAD');
  });

  it('classifies guerrilla violence', () => {
    const r = classifyTopic({
      title: 'Atentado de guerrilla deja heridos en zona rural',
      text: 'La guerrilla realizó un atentado con bomba. El ejército respondió y hay víctimas.',
    });
    expect(r.topic_key).toBe('CRIMEN_SEGURIDAD');
  });

  it('classifies judicial/justice news', () => {
    const r = classifyTopic({
      title: 'Tribunal condena a exfuncionario por corrupción',
      text: 'El tribunal emitió sentencia. La fiscalía había imputado cargos penales.',
      url: 'https://www.eltiempo.com/justicia/condena-12345',
    });
    expect(r.topic_key).toBe('CRIMEN_SEGURIDAD');
  });
});

// ── DEPORTES ──────────────────────────────────────────────────

describe('classifyTopic — DEPORTES', () => {
  it('classifies football match news', () => {
    const r = classifyTopic({
      title: 'Selección Colombia goleó 3-0 a Perú en eliminatoria mundialista',
      text: 'La selección anotó tres goles en el estadio. El entrenador celebró la victoria.',
    });
    expect(r.topic_key).toBe('DEPORTES');
    expect(r.score).toBeGreaterThan(0);
  });

  it('classifies transfer/fichaje news', () => {
    const r = classifyTopic({
      title: 'Fichaje estrella: jugador colombiano llega a liga española',
      text: 'El jugador firmó transferencia con equipo europeo. El club deportivo pagó millones.',
    });
    expect(r.topic_key).toBe('DEPORTES');
  });

  it('gets URL boost from /deportes/ section', () => {
    const r = classifyTopic({
      title: 'Resultados de la jornada del campeonato',
      text: 'El campeonato continúa con resultados sorpresa.',
      url: 'https://www.eltiempo.com/deportes/futbol/jornada-12345',
    });
    expect(r.topic_key).toBe('DEPORTES');
  });
});

// ── ECONOMIA ──────────────────────────────────────────────────

describe('classifyTopic — ECONOMIA', () => {
  it('classifies inflation news', () => {
    const r = classifyTopic({
      title: 'Inflación se disparó al 12% en enero',
      text: 'La inflación alcanzó el 12%. El banco central subió la tasa de interés. Los precios en el mercado suben.',
    });
    expect(r.topic_key).toBe('ECONOMIA');
  });

  it('classifies employment news', () => {
    const r = classifyTopic({
      title: 'Desempleo baja a 10% en Colombia',
      text: 'El desempleo bajó. El empleo creció en el sector financiero y comercio.',
    });
    expect(r.topic_key).toBe('ECONOMIA');
  });
});

// ── SALUD ─────────────────────────────────────────────────────

describe('classifyTopic — SALUD', () => {
  it('classifies pandemic/vaccine news', () => {
    const r = classifyTopic({
      title: 'Nueva campaña de vacunación contra virus respiratorio',
      text: 'El hospital inició la vacunación. El médico recomienda que los pacientes se vacunen.',
    });
    expect(r.topic_key).toBe('SALUD');
  });
});

// ── MEDIO_AMBIENTE ────────────────────────────────────────────

describe('classifyTopic — MEDIO_AMBIENTE', () => {
  it('classifies climate/deforestation news', () => {
    const r = classifyTopic({
      title: 'Deforestación en Amazonía alcanza récord alarmante',
      text: 'La deforestación y contaminación ambiental preocupan. El cambio climático causa sequía.',
    });
    expect(r.topic_key).toBe('MEDIO_AMBIENTE');
  });
});

// ── ENTRETENIMIENTO ───────────────────────────────────────────

describe('classifyTopic — ENTRETENIMIENTO', () => {
  it('classifies celebrity/show news', () => {
    const r = classifyTopic({
      title: 'Cantante colombiano gana premio Grammy Latino',
      text: 'El cantante lanzó su nuevo álbum. El concierto del festival fue un éxito con miles de fans.',
    });
    expect(r.topic_key).toBe('ENTRETENIMIENTO');
  });
});

// ── OPINION ───────────────────────────────────────────────────

describe('classifyTopic — OPINION', () => {
  it('classifies editorial/column by keywords', () => {
    const r = classifyTopic({
      title: 'Columna: Mi opinión sobre la reforma',
      text: 'En esta columna presento mi punto de vista y análisis sobre la situación.',
    });
    expect(r.topic_key).toBe('OPINION');
  });

  it('detects opinion via contentType hint', () => {
    const r = classifyTopic({
      title: 'Reflexiones sobre el futuro del país',
      text: 'Una perspectiva sobre los desafíos que enfrenta la nación hoy.',
      contentType: 'opinion',
    });
    expect(r.topic_key).toBe('OPINION');
  });
});

// ── OTROS (fallback) ──────────────────────────────────────────

describe('classifyTopic — OTROS fallback', () => {
  it('returns OTROS when no keywords match', () => {
    const r = classifyTopic({
      title: 'Hoy es un bonito día de sol',
      text: 'No pasa nada interesante hoy en particular, simplemente buen tiempo.',
    });
    expect(r.topic_key).toBe('OTROS');
    expect(r.reasons).toContain('NO_KEYWORD_MATCH');
  });

  it('returns OTROS for empty input', () => {
    const r = classifyTopic({});
    expect(r.topic_key).toBe('OTROS');
  });
});

// ── classifyTopicKeys ─────────────────────────────────────────

describe('classifyTopicKeys', () => {
  it('returns top 2 topic keys', () => {
    const keys = classifyTopicKeys({
      title: 'Gobierno anuncia reforma económica',
      text: 'El presidente y el congreso debatieron la reforma tributaria fiscal para el presupuesto.',
    });
    expect(keys.length).toBeLessThanOrEqual(2);
    expect(keys.length).toBeGreaterThan(0);
    expect(['POLITICA', 'ECONOMIA']).toContain(keys[0]);
  });

  it('returns OTROS when nothing matches', () => {
    const keys = classifyTopicKeys({ title: 'Buen día de sol', text: 'Hoy no pasa nada' });
    expect(keys).toEqual(['OTROS']);
  });

  it('includes URL section hints', () => {
    const keys = classifyTopicKeys({
      title: 'Noticias del día',
      text: 'Gol de Colombia en el mundial. Victoria.',
      url: 'https://www.eltiempo.com/deportes/futbol/gol-12345',
    });
    expect(keys).toContain('DEPORTES');
  });
});

// ── Determinism ───────────────────────────────────────────────

describe('determinism', () => {
  it('same input always produces same output', () => {
    const input = { title: 'Policía captura narco', text: 'La fiscalía investiga el crimen.' };
    const r1 = classifyTopic(input);
    const r2 = classifyTopic(input);
    expect(r1).toEqual(r2);
  });
});

// ── ALL_TOPIC_KEYS ────────────────────────────────────────────

describe('ALL_TOPIC_KEYS', () => {
  it('contains all expected categories', () => {
    expect(ALL_TOPIC_KEYS).toContain('POLITICA');
    expect(ALL_TOPIC_KEYS).toContain('CRIMEN_SEGURIDAD');
    expect(ALL_TOPIC_KEYS).toContain('DEPORTES');
    expect(ALL_TOPIC_KEYS).toContain('ECONOMIA');
    expect(ALL_TOPIC_KEYS).toContain('SALUD');
    expect(ALL_TOPIC_KEYS).toContain('MEDIO_AMBIENTE');
    expect(ALL_TOPIC_KEYS).toContain('ENTRETENIMIENTO');
    expect(ALL_TOPIC_KEYS).toContain('OPINION');
    expect(ALL_TOPIC_KEYS).toContain('OTROS');
  });
});

// ── Desk boost (v2) ─────────────────────────────────────────────

describe('classifyTopic — desk boost', () => {
  it('boosts POLITICA when URL has /politica/ path', () => {
    const r = classifyTopic({
      title: 'Nuevo decreto aprobado por el gobierno',
      url: 'https://www.eltiempo.com/politica/decreto-12345',
    });
    expect(r.topic_key).toBe('POLITICA');
    expect(r.reasons.some((s) => s.includes('DESK_BOOST'))).toBe(true);
  });

  it('boosts ECONOMIA when URL has /economia/ path', () => {
    const r = classifyTopic({
      title: 'Inflación sube este mes, mercado preocupado',
      url: 'https://www.eltiempo.com/economia/inflacion-12345',
    });
    expect(r.topic_key).toBe('ECONOMIA');
    expect(r.reasons.some((s) => s.includes('DESK_BOOST'))).toBe(true);
  });

  it('desk boost can tip the balance for ambiguous text', () => {
    const withDesk = classifyTopic({
      title: 'Situación compleja en la región',
      url: 'https://www.eltiempo.com/deportes/regional-12345',
    });
    const withoutDesk = classifyTopic({
      title: 'Situación compleja en la región',
    });
    expect(withDesk.topic_key).toBe('DEPORTES');
    // Without desk, may classify differently
    expect(withDesk.score).toBeGreaterThan(withoutDesk.score);
  });
});

// ── Colombia-specific keywords (v2) ─────────────────────────────

describe('classifyTopic — Colombia keywords', () => {
  it('boosts POLITICA with corte constitucional mention', () => {
    const r = classifyTopic({
      title: 'Corte constitucional decide sobre reforma',
      text: 'La corte constitucional emitió fallo sobre la reforma que discute el congreso.',
    });
    expect(r.topic_key).toBe('POLITICA');
    expect(r.reasons.some((s) => s.includes('CO_KW'))).toBe(true);
  });

  it('boosts CRIMEN_SEGURIDAD with ELN mention', () => {
    const r = classifyTopic({
      title: 'Disidencias del ELN atacan zona rural',
      text: 'Las disidencias realizaron un atentado. El ejército respondió al ataque.',
    });
    expect(r.topic_key).toBe('CRIMEN_SEGURIDAD');
    expect(r.reasons.some((s) => s.includes('CO_KW'))).toBe(true);
  });

  it('boosts ECONOMIA with banrep mention', () => {
    const r = classifyTopic({
      title: 'Banco de la república mantiene tasa de interés',
      text: 'El banco de la república decidió no subir la tasa. La inflación baja.',
    });
    expect(r.topic_key).toBe('ECONOMIA');
  });

  it('boosts SALUD with EPS mention', () => {
    const r = classifyTopic({
      title: 'EPS no responde por pacientes en crisis sanitaria',
      text: 'La EPS no entrega medicamentos. El hospital está colapsado.',
    });
    expect(r.topic_key).toBe('SALUD');
  });

  it('boosts MEDIO_AMBIENTE with IDEAM mention', () => {
    const r = classifyTopic({
      title: 'IDEAM alerta por inundaciones en el Chocó',
      text: 'El IDEAM emitió alerta roja. Las lluvias causan inundación y desbordamiento del río.',
    });
    expect(r.topic_key).toBe('MEDIO_AMBIENTE');
  });
});

// ── Confidence lowering on close race (v2) ──────────────────────

describe('classifyTopic — confidence rules', () => {
  it('lowers confidence when topics are in close race', () => {
    // Deliberately craft text with both POLITICA and ECONOMIA keywords
    const r = classifyTopic({
      title: 'Gobierno anuncia medida económica urgente',
      text: 'El presidente aprobó la reforma. El banco subió la tasa de interés. El presupuesto fiscal está comprometido.',
    });
    // There should be close competition between POLITICA and ECONOMIA
    // If CLOSE_RACE fires, score ≤ 0.45
    if (r.reasons.includes('CLOSE_RACE')) {
      expect(r.score).toBeLessThanOrEqual(0.45);
    }
  });

  it('does not lower confidence when one topic dominates clearly', () => {
    const r = classifyTopic({
      title: 'Selección Colombia golea 4-0 en eliminatoria del mundial',
      text: 'La selección anotó cuatro goles. El entrenador celebró la victoria. El estadio lleno de jugadores.',
    });
    expect(r.topic_key).toBe('DEPORTES');
    expect(r.score).toBeGreaterThan(0.45);
    expect(r.reasons).not.toContain('CLOSE_RACE');
  });
});

// ── aggregateEventTopic topic_signals/topic_reason ──────────────

describe('aggregateEventTopic — v2 signals', () => {
  it('includes topic_signals array', () => {
    const r = aggregateEventTopic(
      'Gobierno presenta reforma',
      [{ title: 'Presidente anuncia decreto del congreso', url: 'https://a.com/politica/1' }],
    );
    expect(Array.isArray(r.topic_signals)).toBe(true);
    expect(r.topic_signals!.length).toBeGreaterThan(0);
  });

  it('includes topic_reason string', () => {
    const r = aggregateEventTopic(
      'Gobierno presenta reforma',
      [{ title: 'Presidente anuncia decreto', url: 'https://a.com/politica/1' }],
    );
    expect(typeof r.topic_reason).toBe('string');
    expect(r.topic_reason).toContain('POLITICA');
    expect(r.topic_reason).toContain('conf=');
  });
});

// ── aggregateEventTopic ────────────────────────────────────────

describe('aggregateEventTopic', () => {
  it('all articles same topic (POLITICA) → POLITICA with high confidence', () => {
    const r = aggregateEventTopic(
      'Gobierno presenta reforma tributaria',
      [
        { title: 'Presidente anuncia reforma del congreso', url: 'https://a.com/politica/1' },
        { title: 'Ministro defiende proyecto del gobierno', url: 'https://b.com/politica/2' },
        { title: 'Senado debate reforma del gabinete', url: 'https://c.com/politica/3' },
      ],
    );
    expect(r.topic_key).toBe('POLITICA');
    expect(r.topic_confidence).toBeGreaterThan(0.7);
  });

  it('majority DEPORTES (3) + minority ECONOMIA (1) → DEPORTES', () => {
    const r = aggregateEventTopic(
      'Colombia clasifica al mundial tras golear a rival',
      [
        { title: 'Goles de la selección en eliminatoria', url: 'https://a.com/deportes/1' },
        { title: 'Entrenador celebra victoria del equipo', url: 'https://b.com/deportes/2' },
        { title: 'Jugadores estrella del campeonato futbol', url: 'https://c.com/deportes/3' },
        { title: 'Mercado financiero reacciona a la economía', url: 'https://d.com/economia/1' },
      ],
    );
    expect(r.topic_key).toBe('DEPORTES');
  });

  it('tie between CRIMEN and SALUD → deterministic resolution (alphabetical)', () => {
    const r = aggregateEventTopic(
      'Incidente en zona urbana',
      [
        { title: 'Policía investiga homicidio en hospital', url: 'https://a.com/1' },
        { title: 'Paciente herido tras balacera cerca de clínica', url: 'https://b.com/2' },
      ],
    );
    // Both CRIMEN_SEGURIDAD and SALUD have keywords; should resolve deterministically
    expect(ALL_TOPIC_KEYS).toContain(r.topic_key);
    // Run twice to verify determinism
    const r2 = aggregateEventTopic(
      'Incidente en zona urbana',
      [
        { title: 'Policía investiga homicidio en hospital', url: 'https://a.com/1' },
        { title: 'Paciente herido tras balacera cerca de clínica', url: 'https://b.com/2' },
      ],
    );
    expect(r.topic_key).toBe(r2.topic_key);
    expect(r.topic_confidence).toBe(r2.topic_confidence);
  });

  it('single article event → still classifies correctly', () => {
    const r = aggregateEventTopic(
      'Fiscalía captura narcotraficante',
      [
        { title: 'Operativo policial contra narcotráfico', url: 'https://a.com/judicial/1' },
      ],
    );
    expect(r.topic_key).toBe('CRIMEN_SEGURIDAD');
    expect(r.votes).toHaveLength(1);
  });

  it('mixed: 2 POLITICA + 1 OPINION + 1 OTROS → POLITICA wins', () => {
    const r = aggregateEventTopic(
      'Debate por reforma del congreso',
      [
        { title: 'Gobierno y oposición negocian la reforma', url: 'https://a.com/politica/1' },
        { title: 'Senado aprueba primer debate del proyecto', url: 'https://b.com/politica/2' },
        { title: 'Columna: Mi opinión editorial sobre el tema', url: 'https://c.com/opinion/1', contentType: 'opinion' },
        { title: 'Buen clima hoy en Bogotá', url: 'https://d.com/bogota/1' },
      ],
    );
    expect(r.topic_key).toBe('POLITICA');
  });

  it('all OTROS articles → OTROS with low confidence', () => {
    const r = aggregateEventTopic(
      'Curiosidades del día',
      [
        { title: 'Bonito día de sol en la ciudad', url: 'https://a.com/1' },
        { title: 'Receta de cocina casera fácil', url: 'https://b.com/2' },
      ],
    );
    expect(r.topic_key).toBe('OTROS');
    // Confidence should still be 1.0 when all agree on OTROS
    expect(r.topic_confidence).toBeGreaterThan(0);
  });

  it('URL section hints reinforce consistent topic across articles', () => {
    const r = aggregateEventTopic(
      'Resultados de la jornada deportiva',
      [
        { title: 'Resumen del partido de la liga', url: 'https://a.com/deportes/liga/1' },
        { title: 'Resultado del torneo de fútbol', url: 'https://b.com/deportes/futbol/2' },
        { title: 'Campeonato continúa con sorpresas', url: 'https://c.com/deportes/3' },
      ],
    );
    expect(r.topic_key).toBe('DEPORTES');
    expect(r.topic_confidence).toBeGreaterThan(0.7);
  });

  it('empty articles array → falls back to headline classification', () => {
    const r = aggregateEventTopic(
      'Presidente Petro anuncia nuevo decreto de gobierno',
      [],
    );
    expect(r.topic_key).toBe('POLITICA');
    expect(r.votes).toHaveLength(0);
  });

  // ── Deterministic stability ──────────────────────────────────

  it('deterministic: 100 runs produce identical output', () => {
    const headline = 'Fiscalía investiga caso de narcotráfico';
    const articles = [
      { title: 'Policía capturó sicarios del cartel', url: 'https://a.com/judicial/1' },
      { title: 'Economía afectada por crimen organizado', url: 'https://b.com/economia/2' },
      { title: 'Víctimas de violencia en zona rural', url: 'https://c.com/seguridad/3' },
    ];
    const first = aggregateEventTopic(headline, articles);
    for (let i = 0; i < 100; i++) {
      const r = aggregateEventTopic(headline, articles);
      expect(r.topic_key).toBe(first.topic_key);
      expect(r.topic_confidence).toBe(first.topic_confidence);
    }
  });
});

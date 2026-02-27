import { describe, it, expect } from 'vitest';
import { classifyTopic, classifyTopicKeys, ALL_TOPIC_KEYS } from './topic-heuristic.js';

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

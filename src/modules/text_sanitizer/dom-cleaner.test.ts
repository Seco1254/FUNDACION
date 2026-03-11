import { describe, it, expect } from 'vitest';
import { cleanDom } from './dom-cleaner.js';

// ── HTML Fixture Helpers ─────────────────────────────────────────

/** Wrap body content in a minimal HTML page. */
function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>Test</title></head><body>${body}</body></html>`;
}

/** Create a realistic Colombian news article HTML with common boilerplate. */
function makeArticleHtml(opts: {
  mainContent: string;
  nav?: string;
  footer?: string;
  sidebar?: string;
  comments?: string;
  related?: string;
  cookies?: string;
  donation?: string;
  scripts?: string;
}): string {
  return page([
    opts.nav ?? '',
    '<article>',
    opts.mainContent,
    '</article>',
    opts.sidebar ?? '',
    opts.related ?? '',
    opts.comments ?? '',
    opts.cookies ?? '',
    opts.donation ?? '',
    opts.footer ?? '',
    opts.scripts ?? '',
  ].join('\n'));
}

// ── Fixture: Clean news article ──────────────────────────────────

const CLEAN_NEWS_BODY = `
<h1>Reforma tributaria aprobada por el Congreso con 87 votos a favor</h1>
<p>El Congreso de la República aprobó la reforma tributaria con 87 votos a favor y 23 en contra durante la sesión plenaria del martes.</p>
<p>La medida establece un aumento del 15 por ciento en la recaudación fiscal para el próximo año, según informó el ministro de Hacienda.</p>
<p>Los gremios económicos del país expresaron su preocupación por el impacto en la competitividad empresarial y pidieron ajustes al texto.</p>
<p>Según el ministro de Hacienda, los recursos se destinarán a programas de educación y salud pública en las regiones más afectadas por la pobreza.</p>
<p>Las organizaciones sociales celebraron la aprobación pero advirtieron que vigilarán su implementación en los próximos meses del gobierno.</p>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('cleanDom', () => {

  // ─── Requirement 2: Remove noise tags ──────────────────────────

  describe('strips noise tags (script, style, nav, footer, aside, form)', () => {
    it('removes script and style tags', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        scripts: `
          <script>var ga = 'UA-123'; window.dataLayer = [];</script>
          <script src="analytics.js"></script>
          <style>.paywall { display: block; }</style>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('UA-123');
      expect(result.text).not.toContain('dataLayer');
      expect(result.text).not.toContain('paywall');
      expect(result.text).toContain('reforma tributaria');
    });

    it('removes nav and footer tags', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        nav: '<nav><ul><li><a href="/">Inicio</a></li><li><a href="/colombia">Colombia</a></li></ul></nav>',
        footer: '<footer><p>© 2026 El Tiempo. Todos los derechos reservados. NIT 890.903.790-1</p><p>Cuenta corriente Bancolombia 123-456789-00</p></footer>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Inicio');
      expect(result.text).not.toContain('derechos reservados');
      expect(result.text).not.toContain('NIT');
      expect(result.text).not.toContain('Bancolombia');
      expect(result.text).not.toContain('Cuenta corriente');
      expect(result.text).toContain('Congreso de la República');
    });

    it('removes aside and form tags', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        sidebar: '<aside><h3>Más leídas</h3><ul><li>Otra noticia</li><li>Más noticias</li></ul></aside>',
        cookies: '<form id="newsletter-form"><input placeholder="Tu email"><button>Suscríbete</button></form>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Más leídas');
      expect(result.text).not.toContain('Suscríbete');
      expect(result.text).not.toContain('Tu email');
      expect(result.text).toContain('reforma tributaria');
    });
  });

  // ─── Requirement 2: Remove nodes by class/id regex ─────────────

  describe('strips nodes by class/id regex', () => {
    it('removes elements with comment-related classes', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        comments: '<div class="comments-section"><h3>Comentarios</h3><div class="comment">Buen artículo!</div><div class="comment">No estoy de acuerdo</div></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Buen artículo');
      expect(result.text).not.toContain('No estoy de acuerdo');
      expect(result.text).toContain('reforma tributaria');
    });

    it('removes elements with social/share classes', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY + '<div class="social-share"><a>Compartir en Facebook</a><a>Compartir en Twitter</a></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Compartir en Facebook');
      expect(result.text).not.toContain('Compartir en Twitter');
    });

    it('removes elements with related/recommended classes', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        related: `
          <div class="related-articles">
            <h3>Te puede interesar</h3>
            <a href="/art1">Artículo relacionado uno sobre economía</a>
            <a href="/art2">Artículo relacionado dos sobre política</a>
          </div>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Te puede interesar');
      expect(result.text).not.toContain('Artículo relacionado');
    });

    it('removes elements with newsletter/subscribe classes', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        cookies: '<div class="newsletter-box"><p>Suscríbete a nuestro boletín</p><input placeholder="email"></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Suscríbete a nuestro boletín');
    });

    it('removes cookie banners', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        cookies: '<div id="cookie-banner"><p>Usamos cookies para mejorar tu experiencia. Acepta para continuar.</p><button>Aceptar</button></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('cookies');
      expect(result.text).not.toContain('Aceptar');
    });

    it('removes modal/popup elements', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        cookies: '<div class="popup-overlay"><div class="modal-content"><p>Regístrate gratis</p></div></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Regístrate gratis');
    });

    it('removes ad/promo/banner elements', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        sidebar: '<div class="ad-container"><p>Publicidad patrocinada</p></div><div id="promo-bar"><p>Oferta especial</p></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Publicidad patrocinada');
      expect(result.text).not.toContain('Oferta especial');
    });

    it('removes donation/NIT/account sidebar', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        donation: `
          <div class="sidebar-donations">
            <h3>Apoya nuestro periodismo</h3>
            <p>Dona a nuestra fundación</p>
            <p>NIT 890.903.790-1</p>
            <p>Cuenta corriente Bancolombia 123-456789-00</p>
            <a href="https://patreon.com/example">Apóyanos en Patreon</a>
          </div>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Dona a nuestra fundación');
      expect(result.text).not.toContain('NIT 890.903.790');
      expect(result.text).not.toContain('Bancolombia');
      expect(result.text).not.toContain('Patreon');
    });

    it('removes elements with paywall class', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        cookies: '<div class="paywall-gate"><p>Suscríbase para continuar leyendo</p></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Suscríbase para continuar');
    });
  });

  // ─── Requirement 3: Content container selection ────────────────

  describe('content container selection', () => {
    it('prefers <article> container', () => {
      const html = page(`
        <nav><a>Menu item</a></nav>
        <article>${CLEAN_NEWS_BODY}</article>
        <aside><p>Sidebar stuff that should be ignored by article selection</p></aside>
      `);
      const result = cleanDom({ html });
      expect(result.stats.content_container).toBe('article');
      expect(result.text).toContain('reforma tributaria');
    });

    it('falls back to <main> if no <article>', () => {
      const html = page(`
        <header><nav><a>Menu</a></nav></header>
        <main>${CLEAN_NEWS_BODY}</main>
        <footer><p>Footer text</p></footer>
      `);
      const result = cleanDom({ html });
      expect(result.stats.content_container).toBe('main');
      expect(result.text).toContain('reforma tributaria');
    });

    it('uses heuristic for pages without article/main', () => {
      const html = page(`
        <div class="wrapper">
          <div class="content-body">
            ${CLEAN_NEWS_BODY}
          </div>
          <div class="sidebar"><p>Ad text</p></div>
        </div>
      `);
      const result = cleanDom({ html });
      expect(['heuristic', 'fallback']).toContain(result.stats.content_container);
      expect(result.text).toContain('reforma tributaria');
    });
  });

  // ─── Requirement 4: UGC cutoff ────────────────────────────────

  describe('UGC cutoff', () => {
    it('cuts text at "Comentarios" section header', () => {
      const html = makeArticleHtml({
        mainContent: `
          ${CLEAN_NEWS_BODY}
          <div>
            <h3>Comentarios</h3>
            <p>Usuario1: Excelente artículo, muy informativo.</p>
            <p>Usuario2: No estoy de acuerdo con la reforma tributaria.</p>
          </div>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).toContain('reforma tributaria');
      expect(result.text).not.toContain('Usuario1');
      expect(result.text).not.toContain('No estoy de acuerdo con la reforma');
      expect(result.stats.ugc_cutoff_applied).toBe(true);
    });

    it('cuts at "Deja tu comentario"', () => {
      const html = makeArticleHtml({
        mainContent: `
          ${CLEAN_NEWS_BODY}
          <div>
            <p>Deja tu comentario</p>
            <textarea></textarea>
            <p>Commenter1 wrote something irrelevant here in this UGC section.</p>
          </div>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).toContain('Congreso de la República');
      expect(result.text).not.toContain('Commenter1');
      expect(result.stats.ugc_cutoff_applied).toBe(true);
    });

    it('cuts at "Inicia sesión para comentar"', () => {
      const html = makeArticleHtml({
        mainContent: `
          ${CLEAN_NEWS_BODY}
          <div><p>Inicia sesión para comentar</p><p>Login form placeholder text here.</p></div>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Login form');
      expect(result.stats.ugc_cutoff_applied).toBe(true);
    });

    it('does NOT cut if remaining text would be too short', () => {
      // Very short article followed by comments — should NOT cut
      const shortContent = '<p>Texto corto de prueba.</p>';
      const html = page(`
        <article>
          ${shortContent}
          <p>Comentarios</p>
          <p>Alguien comentó aquí.</p>
        </article>
      `);
      const result = cleanDom({ html });
      // Text is too short overall, so dom cleaner returns empty (fallback)
      expect(result.stats.ugc_cutoff_applied).toBe(false);
    });
  });

  // ─── Requirement 5: Normalization ─────────────────────────────

  describe('normalization', () => {
    it('decodes HTML entities', () => {
      const html = makeArticleHtml({
        mainContent: `
          <p>El presidente dijo que &quot;la reforma es necesaria&quot; y que los impuestos subir&#225;n un 15% en el pr&#243;ximo a&#241;o fiscal del pa&#237;s.</p>
          <p>La medida incluye cambios en el IVA &amp; en la renta para personas jur&#237;dicas y naturales del territorio nacional.</p>
          <p>&#187; Seg&#250;n el ministro, los recursos se destinar&#225;n a educaci&#243;n y salud p&#250;blica en todo el territorio colombiano.</p>
          <p>Los expertos afirmaron que el impacto ser&#225; significativo para la econom&#237;a del pa&#237;s y para la competitividad empresarial.</p>
          <p>Las organizaciones sociales celebraron la aprobaci&#243;n pero advirtieron que vigilar&#225;n su implementaci&#243;n en los meses siguientes.</p>
        `,
      });
      const result = cleanDom({ html });
      expect(result.text).toContain('"la reforma es necesaria"');
      expect(result.text).toContain('IVA &');
      expect(result.text).toContain('subirán');
      expect(result.text).not.toContain('&#225;');
      expect(result.text).not.toContain('&#187;');
    });

    it('collapses excessive whitespace', () => {
      const html = makeArticleHtml({
        mainContent: `
          <p>Primer párrafo sobre la reforma tributaria aprobada por el Congreso de la República.</p>



          <p>Segundo párrafo con información adicional sobre los impactos económicos esperados en el país.</p>
        `,
      });
      const result = cleanDom({ html });
      // Should not have 3+ consecutive newlines
      expect(result.text).not.toMatch(/\n{3,}/);
    });

    it('strips repeated boilerplate lines', () => {
      const html = makeArticleHtml({
        mainContent: `
          <p>Contenido principal del artículo sobre la reforma tributaria aprobada por el Congreso de Colombia.</p>
          <p>La medida establece un aumento del 15% en la recaudación fiscal para el próximo año según el gobierno.</p>
          <p>Los gremios económicos expresaron su preocupación por el impacto en la competitividad empresarial del país.</p>
          <p>Según el ministro de Hacienda, los recursos se destinarán a programas de educación y salud pública regional.</p>
          <div><span>Compartir en Facebook</span></div>
          <div><span>Compartir en Facebook</span></div>
          <p>Las organizaciones sociales celebraron la aprobación pero advirtieron que vigilarán su correcta implementación.</p>
        `,
      });
      const result = cleanDom({ html });
      const matches = result.text.match(/Compartir en Facebook/g);
      expect(!matches || matches.length <= 1).toBe(true);
    });

    it('enforces max length cap (20k chars)', () => {
      // Generate very long content
      const longParagraph = '<p>' + 'La reforma tributaria fue aprobada. '.repeat(200) + '</p>';
      const html = makeArticleHtml({
        mainContent: Array(20).fill(longParagraph).join('\n'),
      });
      const result = cleanDom({ html });
      expect(result.text.length).toBeLessThanOrEqual(20_000);
    });
  });

  // ─── Requirement: Preserve main body for NEWS articles ─────────

  describe('preserves main news content', () => {
    it('preserves a clean news article body intact', () => {
      const html = makeArticleHtml({ mainContent: CLEAN_NEWS_BODY });
      const result = cleanDom({ html });

      expect(result.text).toContain('Reforma tributaria aprobada');
      expect(result.text).toContain('Congreso de la República');
      expect(result.text).toContain('87 votos a favor');
      expect(result.text).toContain('ministro de Hacienda');
      expect(result.text).toContain('educación y salud');
      expect(result.text).toContain('organizaciones sociales');
      expect(result.text.length).toBeGreaterThan(400);
    });

    it('does NOT return empty for a real article', () => {
      const html = makeArticleHtml({ mainContent: CLEAN_NEWS_BODY });
      const result = cleanDom({ html });
      expect(result.text.length).toBeGreaterThan(0);
    });
  });

  // ─── Combined: Full realistic contaminated page ────────────────

  describe('full realistic contaminated page', () => {
    it('cleans a fully contaminated page preserving only news content', () => {
      const html = page(`
        <nav>
          <ul>
            <li><a href="/">Inicio</a></li>
            <li><a href="/colombia">Colombia</a></li>
            <li><a href="/economia">Economía</a></li>
          </ul>
        </nav>

        <div class="cookie-banner" id="cookie-notice">
          <p>Usamos cookies para mejorar tu experiencia. Al continuar navegando aceptas nuestra política de cookies.</p>
          <button>Aceptar cookies</button>
        </div>

        <div class="popup-modal">
          <p>¡Regístrate gratis y accede a contenido exclusivo!</p>
          <input placeholder="Tu email">
        </div>

        <article>
          <h1>Reforma tributaria aprobada por el Congreso con 87 votos a favor</h1>
          <p class="date">19 de febrero de 2026</p>
          <p>El Congreso de la República aprobó la reforma tributaria con 87 votos a favor y 23 en contra durante la sesión plenaria del martes.</p>
          <p>La medida establece un aumento del 15 por ciento en la recaudación fiscal para el próximo año, según informó el ministro de Hacienda.</p>
          <p>Los gremios económicos del país expresaron su preocupación por el impacto en la competitividad empresarial y pidieron ajustes al texto.</p>
          <p>Según el ministro de Hacienda, los recursos se destinarán a programas de educación y salud pública en las regiones más afectadas.</p>
          <p>Las organizaciones sociales celebraron la aprobación pero advirtieron que vigilarán su implementación en los próximos meses.</p>

          <div class="social-share">
            <a>Compartir en Facebook</a>
            <a>Compartir en Twitter</a>
            <a>Compartir en WhatsApp</a>
          </div>
        </article>

        <div class="related-articles">
          <h3>Te puede interesar</h3>
          <a href="/art1">Artículo sobre otro tema totalmente diferente</a>
          <a href="/art2">Más noticias de economía colombiana</a>
          <a href="/art3">Última hora: otro suceso en el país</a>
        </div>

        <aside class="sidebar-widget">
          <div class="newsletter-signup">
            <h4>Suscríbete a nuestro boletín</h4>
            <p>Recibe las noticias más importantes en tu correo.</p>
            <form><input placeholder="email"><button>Enviar</button></form>
          </div>

          <div class="donations-box">
            <h4>Apoya nuestro periodismo</h4>
            <p>NIT 890.903.790-1</p>
            <p>Cuenta corriente Bancolombia 123-456789-00</p>
            <p>Donaciones Nequi: 310-555-1234</p>
          </div>
        </aside>

        <div class="comments-section" id="disqus_thread">
          <h3>Comentarios</h3>
          <div class="comment"><p>Usuario1: Excelente artículo!</p></div>
          <div class="comment"><p>Usuario2: No estoy de acuerdo</p></div>
        </div>

        <footer>
          <p>© 2026 Medio de Comunicación. Todos los derechos reservados.</p>
          <p>NIT 890.903.790-1 | Cuenta bancaria 123-456789</p>
          <p>Términos y condiciones | Política de privacidad</p>
          <a href="mailto:contacto@medio.co">contacto@medio.co</a>
        </footer>

        <script>
          (function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;})(window);
          var dataLayer = [];
        </script>
        <noscript><img src="tracking.gif"></noscript>
      `);

      const result = cleanDom({ html, url: 'https://ejemplo.co/reforma-tributaria' });

      // ✅ News content preserved
      expect(result.text).toContain('Congreso de la República');
      expect(result.text).toContain('87 votos a favor');
      expect(result.text).toContain('ministro de Hacienda');
      expect(result.text).toContain('educación y salud');
      expect(result.text).toContain('organizaciones sociales');

      // ❌ Navigation removed
      expect(result.text).not.toContain('Inicio');

      // ❌ Cookie banner removed
      expect(result.text).not.toMatch(/Usamos cookies/i);

      // ❌ Popup/modal removed
      expect(result.text).not.toContain('Regístrate gratis');

      // ❌ Social share removed
      expect(result.text).not.toContain('Compartir en Facebook');

      // ❌ Related articles removed
      expect(result.text).not.toContain('Te puede interesar');
      expect(result.text).not.toContain('Artículo sobre otro tema');

      // ❌ Newsletter removed
      expect(result.text).not.toContain('Suscríbete a nuestro boletín');

      // ❌ Donation/NIT removed
      expect(result.text).not.toContain('NIT 890');
      expect(result.text).not.toContain('Bancolombia');
      expect(result.text).not.toContain('Nequi');

      // ❌ Comments/UGC removed
      expect(result.text).not.toContain('Usuario1');
      expect(result.text).not.toContain('Usuario2');

      // ❌ Footer removed
      expect(result.text).not.toContain('derechos reservados');
      expect(result.text).not.toContain('Términos y condiciones');

      // ❌ Script/tracking removed
      expect(result.text).not.toContain('GoogleAnalytics');
      expect(result.text).not.toContain('dataLayer');

      // Stats are reasonable
      expect(result.stats.nodes_removed).toBeGreaterThan(5);
      expect(result.stats.content_container).toBe('article');
    });

    it('cleans a page with "te puede interesar" inline in body', () => {
      const html = page(`
        <main>
          <h1>Crisis de seguridad en tres departamentos del país colombiano</h1>
          <p>Las autoridades reportaron un aumento de la violencia en Cauca, Nariño y Valle del Cauca durante las últimas semanas del mes.</p>
          <p>El ministro de Defensa anunció el despliegue de 5.000 efectivos adicionales para controlar la situación en las zonas afectadas.</p>
          <p>Organizaciones de derechos humanos documentaron al menos 15 asesinatos de líderes sociales en lo que va del año dos mil veintiséis.</p>
          <p>La Defensoría del Pueblo emitió una alerta temprana para las comunidades indígenas de la región pacífica del territorio colombiano.</p>
          <p>El presidente convocó un consejo de seguridad extraordinario para evaluar las medidas necesarias contra la violencia regional.</p>

          <div class="recommended-for-you">
            <h3>Te puede interesar</h3>
            <ul>
              <li><a href="/x">Otra noticia sobre violencia regional</a></li>
              <li><a href="/y">Economía colombiana en dificultades</a></li>
            </ul>
          </div>

          <div class="ad-banner">
            <p>Anuncio publicitario de un producto comercial.</p>
          </div>
        </main>
      `);

      const result = cleanDom({ html });

      // Content preserved
      expect(result.text).toContain('Crisis de seguridad');
      expect(result.text).toContain('5.000 efectivos');
      expect(result.text).toContain('Defensoría del Pueblo');

      // Junk removed
      expect(result.text).not.toContain('Te puede interesar');
      expect(result.text).not.toContain('Otra noticia sobre violencia');
      expect(result.text).not.toContain('Anuncio publicitario');
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty text for pages with no meaningful content', () => {
      const html = page('<nav><a>Home</a></nav><footer><p>Copyright</p></footer>');
      const result = cleanDom({ html });
      expect(result.text).toBe('');
      expect(result.stats.chars_after).toBe(0);
    });

    it('handles empty HTML gracefully', () => {
      const result = cleanDom({ html: '' });
      expect(result.text).toBe('');
    });

    it('handles HTML with only scripts', () => {
      const html = page('<script>alert("hello")</script><script>console.log("world")</script>');
      const result = cleanDom({ html });
      expect(result.text).toBe('');
    });

    it('id match works case-insensitively', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        comments: '<div id="Comments-Section"><p>Spam user comment text in this section.</p></div>',
      });
      const result = cleanDom({ html });
      expect(result.text).not.toContain('Spam user comment');
    });
  });

  // ─── Stats reporting ──────────────────────────────────────────

  describe('stats', () => {
    it('reports correct stats for a typical page', () => {
      const html = makeArticleHtml({
        mainContent: CLEAN_NEWS_BODY,
        nav: '<nav><a>Link</a></nav>',
        footer: '<footer><p>Footer</p></footer>',
        scripts: '<script>var x = 1;</script>',
      });
      const result = cleanDom({ html });

      expect(result.stats.chars_before).toBe(html.length);
      expect(result.stats.chars_after).toBeGreaterThan(0);
      expect(result.stats.chars_after).toBeLessThan(result.stats.chars_before);
      expect(result.stats.nodes_removed).toBeGreaterThanOrEqual(3); // nav + footer + script at minimum
    });
  });
});

export function extractMeta(html: string, property: string): string | null {
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const match = html.match(regex);
  if (match) return decodeHtmlEntities(match[1]);

  const regex2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
    'i',
  );
  const match2 = html.match(regex2);
  if (match2) return decodeHtmlEntities(match2[1]);

  return null;
}

export function extractH1(html: string): string | null {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripHtml(match[1]).trim() : null;
}

export function extractLeadParagraph(html: string): string | null {
  const match = html.match(/<p[^>]*class="[^"]*lead[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (match) return stripHtml(match[1]).trim();

  const paragraphs = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
  if (paragraphs) {
    for (const p of paragraphs) {
      const text = stripHtml(p.replace(/<\/?p[^>]*>/gi, '')).trim();
      if (text.length > 40) return text;
    }
  }
  return null;
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function isValidDate(d: Date | null): boolean {
  return d !== null && !isNaN(d.getTime());
}

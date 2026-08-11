export const normalizeUrl = (raw: string) => {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const looksLikeUrl = (raw: string) => {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) || /^[\w-]+(?:\.[\w-]+)+(?:[/?#].*)?$/i.test(trimmed);
};

export const linkMeta = (raw: string) => {
  try {
    const url = new URL(normalizeUrl(raw));
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return {
      url: url.toString(),
      domain: url.hostname.replace(/^www\./, ''),
      title: path ? `${url.hostname.replace(/^www\./, '')}${path.length < 34 ? path : ''}` : url.hostname.replace(/^www\./, ''),
    };
  } catch {
    return { url: raw, domain: raw, title: raw };
  }
};

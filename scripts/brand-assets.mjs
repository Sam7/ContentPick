const markGroup = /<g\b(?=[^>]*\bid="icon")[^>]*>[\s\S]*?<\/g>/;

export function createIconSvg(brandSvg) {
  const mark = brandSvg.match(markGroup)?.[0];
  if (!mark) throw new Error('Brand SVG must define the icon group');

  // Source coordinates keep the original mark paths crisp; this crop excludes the wordmark.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 330 330"><defs>${brandSvg.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? ''}</defs>${mark}</svg>`;
}

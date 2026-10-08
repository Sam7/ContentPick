const markSymbol = /<symbol\b(?=[^>]*\bid="contextpick-mark")[^>]*>[\s\S]*?<\/symbol>/;

export function createIconSvg(brandSvg) {
  const symbol = brandSvg.match(markSymbol)?.[0];
  if (!symbol) throw new Error('Brand SVG must define the contextpick-mark symbol');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs>${symbol}</defs><use href="#contextpick-mark" width="256" height="256"/></svg>`;
}

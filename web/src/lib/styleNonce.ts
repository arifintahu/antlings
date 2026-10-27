// The CSP allows <style> elements only with the page's nonce. xterm.js creates its own <style> elements
// and has no nonce option, so every <style> made through createElement gets the nonce.
export function installStyleNonce(doc: Document): void {
  const nonce = doc.querySelector('meta[name="csp-nonce"]')?.getAttribute('content');
  if (!nonce || nonce.startsWith('__')) return; // dev server or no nonce: nothing to tag
  const create = doc.createElement.bind(doc) as (
    tag: string,
    options?: ElementCreationOptions,
  ) => HTMLElement;
  doc.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const el = create(tag, options);
    if (tag.toLowerCase() === 'style') el.setAttribute('nonce', nonce);
    return el;
  }) as Document['createElement'];
}

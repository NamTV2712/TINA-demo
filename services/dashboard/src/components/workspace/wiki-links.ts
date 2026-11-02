interface Node { type: string; value?: string; url?: string; children?: Node[] }

// Transform prose nodes only: fenced code, inline code and existing links retain their text.
export function remarkWikiLinks() {
  function visit(node: Node) {
    if (!node.children || node.type === 'link') return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text') { visit(child); return [child]; }
      return (child.value || '').split(/(\[\[[^\]]+\]\])/g).filter(Boolean).map(value => {
        if (!value.startsWith('[[')) return { type: 'text', value };
        const [target, ...alias] = value.slice(2, -2).split('|');
        return { type: 'link', url: '#knowledge=' + encodeURIComponent(target.trim()), children: [{ type: 'text', value: alias.length ? alias.join('|') : target }] };
      });
    });
  }
  return visit;
}

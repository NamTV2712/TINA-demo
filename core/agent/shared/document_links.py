"""Source-preserving rewrites for the static Markdown links supported by Knowledge."""
import posixpath
import re
from urllib.parse import quote, unquote, urlsplit

_ROOTS = ('kg/', 'wiki/', 'notes/', 'docs/', 'sources/', 'concepts/')
# shortcut: static Markdown/MDX links only; use a full parser if executable MDX references need migration.
_TOKENS = re.compile(
    r'(?P<code>(?P<ticks>`+)(?!`)[\s\S]*?(?<!`)(?P=ticks)(?!`))'
    r'|(?P<wiki>\[\[(?P<wikilink>[^\]\n]+)\]\])'
    r'|(?P<markdown>!?\[[^\]\n]*\]\(\s*(?P<destination><[^>\n]+>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:[ \t]+(?:"[^"\n]*"|\x27[^\x27\n]*\x27|\([^()\n]*\)))?[ \t]*\))'
    r'|(?P<definition>^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?P<reference><[^>\n]+>|[^\s]+))'
    r'|(?P<html>\bhref\s*=\s*(?P<quotation>["\x27])(?P<attribute>[^\r\n]*?)(?P=quotation))'
    r'|(?P<mention>@file:(?P<file>[A-Za-z0-9._~%+@:/=-]+))', re.MULTILINE,
)


def wikilink_paths(reference, document, paths):
    """Resolve a title or an aliased, encoded path within one workspace's visible corpus."""
    target = reference.split('|', 1)[0].strip()
    target = unquote(re.split(r'[?#]', target, maxsplit=1)[0])
    if not target or target.startswith('//') or urlsplit(target).scheme:
        return []
    if '/' not in target and not target.endswith('.md'):
        slug = re.sub(r'[^a-z0-9]+', '-', target.lower()).strip('-')
        return [path for path in paths if posixpath.basename(path) == slug + '.md']
    rooted = target.startswith('/') or target.startswith(_ROOTS) or target == 'README.md'
    relative = posixpath.normpath(posixpath.join(posixpath.dirname(document), target))
    candidates = [target.lstrip('/'), relative] if not target.startswith(('./', '../')) else [relative]
    if rooted:
        candidates = [posixpath.normpath(target.lstrip('/'))]
    for path in candidates:
        if path != '..' and not path.startswith('../') and path in paths:
            return [path]
    return []


def rewrite_links(text, source, destination, document, paths, workspace):
    """Return new bytes-as-text, replacement count and links requiring manual review."""
    after = destination if document == source else document
    count, warnings = 0, set()

    def resolve(value):
        head = re.split(r'[?#]', value, maxsplit=1)[0]
        suffix = value[len(head):]
        if not head or value.startswith('//') or urlsplit(value).scheme:
            return None, suffix, False
        head = unquote(re.sub(r'\\([() ])', r'\1', head))
        if head.startswith(workspace + '/'):
            return head[len(workspace) + 1:], suffix, False
        rooted = head.startswith('/') or head.startswith(_ROOTS) or head == 'README.md'
        target = posixpath.normpath(head.lstrip('/') if rooted else posixpath.join(posixpath.dirname(document), head))
        if target == '..' or target.startswith('../'):
            return None, suffix, False
        return target, suffix, not rooted

    def rewrite(match):
        nonlocal count
        if match.group('code'):
            return match[0]
        if match.group('wiki'):
            target, separator, label = match.group('wikilink').partition('|')
            target = target.strip()
            if '/' not in target and not target.endswith('.md'):
                candidates = wikilink_paths(target, document, paths)
                if source not in candidates:
                    return match[0]
                if len(candidates) != 1:
                    warnings.add(f'{document}: ambiguous wikilink [[{target}]]')
                    return match[0]
                resolved, suffix, relative = source, '', False
            else:
                resolved, suffix, relative = resolve(target)
            if resolved != source and not (document == source and relative and after != document):
                return match[0]
            if resolved is None:
                return match[0]
            updated = destination if resolved == source else resolved
            count += 1
            return '[[' + quote(updated, safe='/._-~') + suffix + '|' + (label if separator else target) + ']]'
        group = next(key for key in ('destination', 'reference', 'attribute', 'file') if match.group(key) is not None)
        raw = match.group(group)
        angled = raw.startswith('<') and raw.endswith('>')
        value = raw[1:-1] if angled else raw
        resolved, suffix, relative = resolve(value)
        if resolved is None or (resolved != source and not (document == source and relative and after != document)):
            return match[0]
        target = destination if resolved == source else resolved
        href = posixpath.relpath(target, posixpath.dirname(after) or '.') if relative else target
        encoded = quote(href, safe='/._-~') + suffix
        if angled:
            encoded = '<' + encoded + '>'
        start, end = match.start(group) - match.start(), match.end(group) - match.start()
        count += 1
        return match[0][:start] + encoded + match[0][end:]

    result, prose, fence = [], [], None
    frontmatter = text.startswith(('---\n', '---\r\n'))
    for number, line in enumerate(text.splitlines(keepends=True)):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if fence:
            result.append(line)
            if re.fullmatch(r' {0,3}' + re.escape(fence[0]) + '{' + str(fence[1]) + r',}[ \t]*\r?\n?', line):
                fence = None
            continue
        if marker or (not frontmatter and line.startswith(('    ', '\t'))):
            result.append(_TOKENS.sub(rewrite, ''.join(prose))); prose = []
            result.append(line)
            if marker:
                fence = (marker[1][0], len(marker[1]))
            continue
        prose.append(line)
        if frontmatter and number and line.strip() == '---':
            frontmatter = False
    result.append(_TOKENS.sub(rewrite, ''.join(prose)))
    return ''.join(result), count, sorted(warnings)

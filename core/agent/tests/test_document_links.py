from shared.document_links import rewrite_links, wikilink_paths


def test_wikilink_resolution_supports_aliases_encoded_paths_and_relative_paths():
    paths = ['notes/new plan.md', 'kg/entities/project/budget.md', 'notes/budget.md']
    assert wikilink_paths('notes/new%20plan.md#details|Budget', 'kg/entities/meeting/demo.md', paths) == ['notes/new plan.md']
    assert wikilink_paths('../../../notes/new%20plan.md|Budget', 'kg/entities/meeting/demo.md', paths) == ['notes/new plan.md']
    assert set(wikilink_paths('Budget|Label', 'README.md', paths)) == {'kg/entities/project/budget.md', 'notes/budget.md'}
    assert wikilink_paths('https://example.test/notes/new%20plan.md', 'README.md', paths) == []
    assert wikilink_paths('../../notes/new%20plan.md', 'README.md', paths) == []


def test_static_links_keep_formatting_aliases_fragments_and_code():
    text = ('---\nrelated: ["[[Budget]]"]\n---\n'
            '[[Budget]] and [[wiki/budget.md|Plan]]\n'
            '[Budget](../wiki/budget.md#details "Title")\n'
            '[reference]: <../wiki/budget.md?view=1#details> "Title"\n'
            '<Card href="wiki/budget.md" /> @file:wiki/budget.md\n'
            '`[[Budget]]`\n~~~md\n[[Budget]]\n~~~\n'
            '    [example](../wiki/budget.md)\n'
            '[external](https://example.test/wiki/budget.md)\n')
    value, count, warnings = rewrite_links(text, 'wiki/budget.md', 'notes/new plan.md', 'docs/index.md', ['wiki/budget.md', 'docs/index.md'], '/workspace')
    assert 'related: ["[[notes/new%20plan.md|Budget]]"]' in value
    assert '[[notes/new%20plan.md|Plan]]' in value
    assert '[Budget](../notes/new%20plan.md#details "Title")' in value
    assert '[reference]: <../notes/new%20plan.md?view=1#details> "Title"' in value
    assert '<Card href="notes/new%20plan.md" /> @file:notes/new%20plan.md' in value
    assert '`[[Budget]]`\n~~~md\n[[Budget]]\n~~~' in value
    assert '    [example](../wiki/budget.md)' in value
    assert '[external](https://example.test/wiki/budget.md)' in value
    assert count == 7 and warnings == []


def test_moved_document_rebases_outgoing_relative_links_and_self_links():
    text = '[Other](./other.md) ![Image](images/demo.png) [[./other.md|Other]] [Self](./budget.md#intro)'
    value, count, warnings = rewrite_links(text, 'wiki/budget.md', 'notes/deep/new.md', 'wiki/budget.md', ['wiki/budget.md', 'wiki/other.md'], '/workspace')
    assert value == '[Other](../../wiki/other.md) ![Image](../../wiki/images/demo.png) [[wiki/other.md|Other]] [Self](new.md#intro)'
    assert count == 4 and not warnings


def test_ambiguous_titles_are_reported_and_not_rewritten():
    value, count, warnings = rewrite_links('[[Budget]]', 'wiki/budget.md', 'notes/new.md', 'docs/a.md', ['wiki/budget.md', 'notes/budget.md'], '/workspace')
    assert value == '[[Budget]]' and count == 0
    assert warnings == ['docs/a.md: ambiguous wikilink [[Budget]]']

from llm.citations import render_citations, web_sources


def test_web_sources_accepts_explicit_result_metadata_and_opened_pages():
    assert web_sources({"type": "webSearch", "results": [
        {"url": "https://docs.python.org/3/library/pathlib.html", "title": "pathlib — Python docs",
         "reference_id": "turn0search0"},
    ], "action": {"type": "openPage", "url": "https://example.com/guide"}}) == [
        {"url": "https://docs.python.org/3/library/pathlib.html", "title": "pathlib — Python docs", "refs": ["turn0search0"]},
        {"url": "https://example.com/guide", "title": "example.com/guide", "refs": []},
    ]
    assert web_sources({"type": "web_search_call", "action": {
        "type": "open_page", "url": "https://docs.python.org/3/library/pathlib.html",
    }})[0]["refs"] == []


def test_unrelated_tool_payloads_and_unsafe_urls_are_not_sources():
    assert web_sources({"type": "function_call_output", "results": [{"url": "https://example.com"}]}) == []
    urls = ["javascript:alert(1)", "data:text/plain,hello", "//example.com", "https://user:pass@example.com",
            "https://example.com/\nspoof", "https://example.com/%0d%0aheader", "https://example.com\\bad",
            "https://[invalid", "https://example.com:bad/", "https:// /bad"]
    assert web_sources({"type": "webSearch", "results": [{"url": url} for url in urls]}) == []
    assert web_sources({"type": "webSearch", "results": [{"payload": {"url": "https://example.com"}}]}) == []


def test_only_explicit_refs_resolve_multiple_citations_and_urls_are_deduped():
    sources = [
        {"url": "https://example.com/a", "title": "Source A", "refs": ["turn0search0", "turn0view1"]},
        {"url": "https://example.com/b", "title": "Source B", "refs": ["turn0search1"]},
        {"url": "https://example.com/a", "title": "Source A", "refs": ["turn1fetch0"]},
    ]
    text = "Verified. citeturn0search0turn0search1turn0view1 Another citeturn1fetch0"
    rendered = render_citations(text, sources)
    assert rendered.startswith("Verified. [Source A](https://example.com/a), [Source B](https://example.com/b) Another [Source A](https://example.com/a)")
    assert rendered.count("- [Source A](https://example.com/a)") == 1
    assert rendered.count("- [Source B](https://example.com/b)") == 1
    assert render_citations(rendered, sources) == rendered


def test_missing_refs_never_guess_at_single_opened_page():
    sources = [{"url": "https://example.com/opened", "title": "Opened page", "refs": []}]
    rendered = render_citations("Claim. citeturn0search0", sources)
    assert rendered.startswith("Claim. [Nguồn chưa có liên kết]")
    assert "- [Opened page](https://example.com/opened)" in rendered
    assert "turn0search0" not in rendered
    assert render_citations("Claim. citeturn0search0", []) == "Claim. [Nguồn chưa có liên kết]"


def test_code_examples_and_existing_markdown_links_are_unchanged():
    marker = "citeturn0search0"
    text = (f"`{marker}` and ``code `{marker}` ``\n"
            f"```text\n{marker}\n```\n"
            f"~~~~text\n{marker}\n~~~~~\n"
            f"    {marker}\n"
            "[Already cited](https://example.com/docs?q=1#section)\n")
    assert render_citations(text, []) == text


def test_source_titles_and_urls_cannot_inject_markdown_links():
    source = {"url": "https://example.com/a (b)?q=[x]", "title": "Title [x](javascript:alert(1))\n**bold**", "refs": ["turn0search0"]}
    rendered = render_citations("citeturn0search0", [source])
    assert "https://example.com/a%20%28b%29?q=%5Bx%5D" in rendered
    assert "Title \\[x\\]\\(javascript:alert\\(1\\)\\) \\*\\*bold\\*\\*" in rendered
    assert "\n**bold**" not in rendered
    assert render_citations("citeturn0search0", [{"url": "javascript:alert(1)", "refs": ["turn0search0"]}]) == "[Nguồn chưa có liên kết]"


def test_conflicting_explicit_refs_remain_unresolved_instead_of_guessing():
    sources = [{"url": f"https://example.com/{name}", "title": name, "refs": ["turn0search0"]} for name in ("a", "b")]
    assert render_citations("citeturn0search0", sources).startswith("[Nguồn chưa có liên kết]")


def test_source_extraction_and_bibliography_are_bounded():
    sources = [{"url": f"https://example.com/{index}"} for index in range(60)]
    assert len(web_sources({"type": "webSearch", "results": sources})) == 50
    rendered = render_citations("Notes", sources)
    assert rendered.count("\n- [") == 50

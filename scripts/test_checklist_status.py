#!/usr/bin/env python3
"""Small runnable regression check for the Markdown-driven issue tracker."""
import contextlib
import io
from itertools import product
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
import build_checklist_status as tracker


def check_browser():
    """Optional: .venv/bin/python scripts/test_checklist_status.py --browser."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(tracker.OUTPUT.as_uri())
        items = tracker.parse_checklist(tracker.CHECKLIST.read_text())
        for flags in product((False, True), repeat=3):
            selected = {status for status, enabled in zip(('open', 'partial', 'closed'), flags) if enabled}
            for status, enabled in zip(('open', 'partial', 'closed'), flags):
                page.locator(f'#status input[value="{status}"]').set_checked(enabled)
            visible = page.locator('article:visible').evaluate_all('(cards) => cards.map(card => card.id)')
            assert set(visible) == {item['id'] for item in items if item['status'] in selected}
        page.locator('#status input[value="closed"]').uncheck()
        page.select_option('#priority', 'P1')
        expected = {item['id'] for item in items if item['status'] in ('open', 'partial') and item['priority'] == 'P1'}
        assert set(page.locator('article:visible').evaluate_all('(cards) => cards.map(card => card.id)')) == expected
        assert page.locator('#current-work').is_visible()
        active = [item for item in items if item['status'] != 'closed' and item['fields'].get('Started')]
        assert page.locator('#current-work a').count() == 2 * len(active)
        if active:
            issue_id = active[0]['id']
            page.locator('#search').fill('no-matching-issue')
            page.locator(f'#current-work a[href="#{issue_id}"]').first.click()
            page.wait_for_function('(id) => !document.getElementById(id).hidden && document.getElementById(id).querySelector("details").open', arg=issue_id)
            assert page.locator(f'#{issue_id} details').get_attribute('open') is not None
        assert page.locator('#completion-history').is_visible()
        page.locator('#completion-history a[href="#UI-01"]').first.click()
        page.wait_for_function('!document.querySelector("#UI-01").hidden && document.querySelector("#UI-01 details").open')
        assert page.locator('#UI-01 details').get_attribute('open') is not None
        page.locator('#search').fill('no-matching-issue')
        page.locator('#completion-history a[href="#UI-01"]').first.click()
        page.wait_for_function('!document.querySelector("#UI-01").hidden')
        page.get_by_role('button', name='Clear filters').click()
        page.wait_for_function('document.querySelectorAll("article[hidden]").length === 0')
        assert page.locator('#status input:checked').count() == 3
        assert page.locator('#count-total').inner_text() == str(len(items))
        for width in (320, 390, 768, 1024):
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        for section_id in ('current-work', 'completion-history'):
            assert page.locator(f'#{section_id} th').all_text_contents() == ['Start DT', 'Complete DT', 'Model', 'Task ID', 'Task Title']
        ongoing_ids = set(page.locator('#current-work tr[data-task-id]').evaluate_all('(rows) => rows.map(row => row.dataset.taskId)'))
        done_ids = set(page.locator('#completion-history tr[data-task-id]').evaluate_all('(rows) => rows.map(row => row.dataset.taskId)'))
        assert not ongoing_ids & done_ids
        assert done_ids == {item['id'] for item in items if item['status'] == 'closed'}
        assert page.locator('.tracking-missing').first.evaluate('(cell) => getComputedStyle(cell).textAlign') == 'center'
        fixture = '# Section 0 - Example\n'
        for issue_id, model in [('TEST-01', 'GPT-6 Astra Light'), ('TEST-02', 'Another Model High')]:
            fixture += f'### {issue_id} — Concurrent task\n**Priority:** P0\n**Started:** 2026-09-06T16:35:07+00:00\n**Model:** {model}\n- [ ] Finish\n'
        fixture_page, _ = tracker.render_document(fixture, tracker.TEMPLATE.read_text())
        page.close()
        page = browser.new_page(viewport={'width': 320, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(fixture_page)
        assert page.locator('#current-work tr[data-task-id]').count() == 2
        for row in page.locator('#current-work tr[data-task-id]').all():
            assert row.locator('td').nth(0).inner_text() == '09/06/26 12:35 PM'
            assert row.locator('td').nth(1).inner_text() == ''
            assert row.locator('a').count() == 2
        assert page.locator('#current-work td').nth(2).inner_text() == 'GPT-6 Astra Light'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        browser.close()
    print('Browser: all eight status combinations, priority intersection, reset and narrow layouts pass.')


def main():
    source = '''# Section 1 — Example
### TEST-01 — Closed example
**Priority:** P1
**Recommendation:** Keep the regression.
- [x] Done
```text
### FAKE-99 — Not an issue
- [ ] Not an acceptance box
```
### TEST-02 — Partial example
**Priority:** P2
- [x] One done
- [ ] One remaining
### TEST-03 — Open example
**Priority:** P3
- [ ] Remaining
~~~text
- [x] Not done
~~~
'''
    items = tracker.parse_checklist(source)
    assert [i['id'] for i in items] == ['TEST-01', 'TEST-02', 'TEST-03']
    assert [i['status'] for i in items] == ['closed', 'partial', 'open']
    assert [i['total'] for i in items] == [1, 2, 1]
    template = tracker.TEMPLATE.read_text()
    page, counts = tracker.render_document(source, template)
    assert counts == {'closed': 1, 'partial': 1, 'open': 1}
    assert page.count('<article ') == 3
    history = page.split('id="completion-history"', 1)[1].split('<tbody>', 1)[1].split('</tbody>', 1)[0]
    assert 'href="#TEST-01"' in history and 'href="#TEST-02"' not in history
    dated = source
    dated += '\n### TEST-04 — Later completion\n**Priority:** P2\n**Completed:** 2026-09-05T18:00:00-04:00\n- [x] Done\n'
    dated += '\n### TEST-05 — Earlier completion\n**Priority:** P2\n**Completed:** 2026-09-05T20:00:00+00:00\n- [x] Done\n'
    dated_page, _ = tracker.render_document(dated, template)
    history = dated_page.split('id="completion-history"', 1)[1].split('<tbody>', 1)[1].split('</tbody>', 1)[0]
    assert history.index('#TEST-04') < history.index('#TEST-05') < history.index('#TEST-01')
    assert dated_page.index('id="completion-history"') < dated_page.index('id="issues"')
    started_source = source + '\n### TEST-06 — In progress\n**Priority:** P0\n**Started:** 2026-09-06T12:35:07-04:00\n**Model:** GPT-6 Astra Light\n- [ ] Finish\n'
    started_page, _ = tracker.render_document(started_source, template)
    current = started_page.split('id="current-work"', 1)[1].split('</section>', 1)[0]
    assert current.count('href="#TEST-06"') == 2
    assert '09/06/26 12:35 PM' in current and '<td></td>' in current
    assert '<td>GPT-6 Astra Light</td>' in current
    finished_source = started_source.replace('- [ ] Finish', '**Completed:** 2026-09-06T13:00:00-04:00\n- [x] Finish')
    finished_page, _ = tracker.render_document(finished_source, template)
    assert 'href="#TEST-06"' not in finished_page.split('id="current-work"', 1)[1].split('</section>', 1)[0]
    completed_table = finished_page.split('id="completion-history"', 1)[1].split('</section>', 1)[0]
    assert completed_table.count('href="#TEST-06"') == 2
    assert '09/06/26 12:35 PM' in completed_table and '09/06/26 01:00 PM' in completed_table
    assert '<td>GPT-6 Astra Light</td>' in completed_table
    assert '<td class="tracking-missing">-</td>' in completed_table
    assert '<th scope="col">Start DT</th><th scope="col">Complete DT</th><th scope="col">Model</th><th scope="col">Task ID</th><th scope="col">Task Title</th>' in current
    assert started_page.index('id="current-work"') < started_page.index('id="completion-history"')
    assert 'Not an acceptance box' in page and 'Not done' in page
    assert 'Keep the regression.' in page
    for invalid in (
        source + '\n### TEST-01 — Duplicate\n',
        source.replace('**Priority:** P3', '**Priority:** P3\n**Status:** [x]'),
        source + '\n```unclosed\n',
        source.replace('### TEST-03 —', '### TEST-03:'),
    ):
        try:
            tracker.parse_checklist(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid source accepted')
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        checklist, output = folder / 'input.md', folder / 'output.html'
        checklist.write_text(source)
        with patch.object(tracker, 'CHECKLIST', checklist), patch.object(tracker, 'OUTPUT', output), contextlib.redirect_stdout(io.StringIO()):
            with patch('sys.argv', ['tracker']):
                assert tracker.main() == 0
            with patch('sys.argv', ['tracker', '--check']):
                assert tracker.main() == 0
                output.write_text('stale')
                assert tracker.main() == 1
    real_items = tracker.parse_checklist(tracker.CHECKLIST.read_text())
    assert all(i['fields'].get('Recommendation') and any(key.startswith('Review (') for key in i['fields']) for i in real_items)
    assert len({i['id'] for i in real_items}) == len(real_items)
    print('Tracker parser, counters, full cards, fences, validation and freshness checks passed.')
    if '--browser' in sys.argv:
        check_browser()


if __name__ == '__main__':
    main()

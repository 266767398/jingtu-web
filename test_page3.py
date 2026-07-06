import asyncio, sys, os
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.path.expanduser('~/AppData/Local/ms-playwright')
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('console', lambda msg: errors.append(f"[{msg.type}] {msg.text}") if msg.type == 'error' else None)
        page.on('pageerror', lambda err: errors.append(f"[PAGE_CRASH] {err}"))

        await page.goto('http://localhost:3456', wait_until='networkidle', timeout=15000)
        await page.wait_for_timeout(1500)

        print("=== Login overlay visible ===")
        print(await page.is_visible('#loginOverlay'))

        print("\n=== Clicking Events tab ===")
        await page.click('#tab-btn-events')
        await page.wait_for_timeout(4000)

        print("\n=== Events tab classes ===")
        classes = await page.evaluate("() => document.getElementById('tab-events')?.className || 'NOT FOUND'")
        print(classes)

        print("\n=== Events list content ===")
        html = await page.evaluate("() => document.getElementById('eventsList')?.innerHTML?.substring(0, 600) || 'MISSING'")
        print(html)

        print("\n=== Counts ===")
        events = await page.evaluate("() => document.querySelectorAll('.event-card').length")
        skeletons = await page.evaluate("() => document.querySelectorAll('.skeleton-card').length")
        empty = await page.evaluate("() => document.querySelectorAll('.empty-state').length")
        print(f"event-cards: {events}, skeleton-cards: {skeletons}, empty-states: {empty}")

        print("\n=== Console errors ===")
        for e in errors[:10]:
            print(e)

        await page.screenshot(path='/tmp/jingtu_page3.png', full_page=False)
        print("\nScreenshot: /tmp/jingtu_page3.png")
        await browser.close()

asyncio.run(main())

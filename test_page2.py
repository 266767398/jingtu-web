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

        # Step 1: Navigate
        print("1. Loading page...")
        await page.goto('http://localhost:3456', wait_until='networkidle', timeout=15000)
        await page.wait_for_timeout(1000)
        
        # Step 2: Login
        print("2. Logging in...")
        await page.fill('#loginId', 'test')
        await page.fill('#loginPassword', 'Test1234!')
        await page.click('#loginPwdBtn')
        await page.wait_for_timeout(2000)
        
        login_visible = await page.is_visible('#loginOverlay')
        print(f"   Login overlay visible: {login_visible}")
        
        if login_visible:
            # Check for error toast
            toast = await page.query_selector('.toast.error')
            if toast:
                text = await toast.text_content()
                print(f"   Login error toast: {text}")
        
        # Step 3: Check if app is visible
        app_visible = await page.evaluate("() => { return document.getElementById('loginOverlay')?.style?.display === 'none'; }")
        print(f"   App visible: {app_visible}")
        
        # Step 4: Click events tab
        print("3. Clicking Events tab...")
        await page.click('#tab-btn-events')
        await page.wait_for_timeout(3000)
        
        # Step 5: Check events tab visibility
        events_tab = await page.query_selector('#tab-events')
        if events_tab:
            classes = await events_tab.get_attribute('class')
            is_hidden = 'd-none' in (classes or '')
            print(f"   Events tab visible: {not is_hidden}")
            print(f"   Events tab class: {classes}")
        else:
            print("   Events tab NOT FOUND!")
        
        # Step 6: Check events list content
        events_list_html = await page.evaluate("""
            () => {
                const el = document.getElementById('eventsList');
                if (!el) return 'MISSING eventsList element';
                return el.innerHTML.substring(0, 500);
            }
        """)
        print(f"   Events list content (500 chars): {events_list_html}")
        
        # Step 7: Check for event cards
        event_count = await page.evaluate("() => document.querySelectorAll('.event-card').length")
        skeleton_count = await page.evaluate("() => document.querySelectorAll('.skeleton-card').length")
        print(f"   Event cards: {event_count}, Skeleton cards: {skeleton_count}")
        
        # Step 8: Check network
        print("4. Console errors:")
        for e in errors[:10]:
            print(f"   {e}")

        # Screenshot
        await page.screenshot(path='/tmp/jingtu_page2.png', full_page=False)
        print("Screenshot saved to /tmp/jingtu_page2.png")
        
        await browser.close()

asyncio.run(main())

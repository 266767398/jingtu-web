"""Test jingtu-web page loading and events tab."""
from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    
    # Collect console errors
    console_errors = []
    page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: console_errors.append(f"[PAGE ERROR] {err}"))
    
    # Navigate and wait
    print("=== Navigating to http://localhost:3456 ===")
    page.goto("http://localhost:3456", wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(3000)
    
    # Check page title
    title = page.title()
    print(f"Page title: {title}")
    
    # Check login overlay
    login_overlay = page.locator("#loginOverlay")
    login_visible = login_overlay.is_visible()
    print(f"Login overlay visible: {login_visible}")
    
    # Check events tab
    events_tab = page.locator("#tab-events")
    events_tab_exists = events_tab.count() > 0
    print(f"Events tab exists: {events_tab_exists}")
    
    # Check events list
    events_list = page.locator("#eventsList")
    events_list_html = events_list.inner_html() if events_list.count() > 0 else "NOT FOUND"
    print(f"Events list HTML (first 300 chars): {events_list_html[:300]}")
    
    # Check skeleton cards
    skeleton_cards = page.locator(".skeleton-card")
    skeleton_count = skeleton_cards.count()
    print(f"Skeleton cards visible: {skeleton_count}")
    
    # Check tab buttons
    tab_buttons = page.locator(".tab")
    print(f"Tab buttons found: {tab_buttons.count()}")
    
    # Check for d-none classes
    tab_contents = page.locator(".tab-content")
    for i in range(tab_contents.count()):
        el = tab_contents.nth(i)
        el_id = el.get_attribute("id")
        is_dnone = "d-none" in (el.get_attribute("class") or "")
        is_visible = el.is_visible()
        inner_html = el.inner_html()[:100] if el.count() > 0 else ""
        print(f"  Tab content #{i}: id={el_id}, d-none={is_dnone}, visible={is_visible}")
    
    # Take screenshot
    page.screenshot(path="/tmp/jingtu_page.png", full_page=True)
    print("Screenshot saved to /tmp/jingtu_page.png")
    
    # Print console errors
    if console_errors:
        print("\n=== Console Errors ===")
        for err in console_errors:
            print(f"  {err}")
    else:
        print("\nNo console errors")
    
    # Print page content summary
    body_html = page.locator("body").inner_html()
    print(f"\nBody HTML length: {len(body_html)} chars")
    
    browser.close()
    print("\nDone.")

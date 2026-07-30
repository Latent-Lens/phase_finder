#!/usr/bin/env python3
"""Small native-Safari check against the deployed production artifact."""

import os
import json
from urllib.parse import urlparse
from selenium import webdriver

target = os.environ.get("PHASEFINDER_SAFARI_URL")
username = os.environ.get("BROWSERSTACK_USERNAME")
access_key = os.environ.get("BROWSERSTACK_ACCESS_KEY")
if not all((target, username, access_key)):
    raise SystemExit("PHASEFINDER_SAFARI_URL and BrowserStack credentials are required")
if urlparse(target).scheme != "https" or not urlparse(target).netloc:
    raise SystemExit("PHASEFINDER_SAFARI_URL must be a public HTTPS deployment")

options = webdriver.SafariOptions()
options.set_capability("bstack:options", {
    "os": "OS X",
    "osVersion": "Sequoia",
    "sessionName": "PhaseFinder production smoke",
})
driver = webdriver.Remote(
    command_executor=f"https://{username}:{access_key}@hub-cloud.browserstack.com/wd/hub",
    options=options,
)
try:
    driver.get(target)
    assert driver.title == "PhaseFinder"
    assert driver.find_element("id", "drop_zone").is_displayed()
    help_url = driver.find_element("css selector", "#status_bar a[href='help.html']").get_attribute("href")
    driver.get(help_url)
    assert "PhaseFinder Help" in driver.title
    print(driver.capabilities)
except Exception as error:
    driver.save_screenshot("safari-failure.png")
    try:
        browser_log = driver.get_log("browser")[-20:]
    except Exception as log_error:
        browser_log = [f"Browser log unavailable: {log_error}"]
    with open("safari-failure.json", "w", encoding="utf-8") as report:
        json.dump({
            "error": str(error)[:4000],
            "browser": driver.capabilities,
            "console": browser_log,
            "url": target,
        }, report, indent=2, default=str)
    raise
finally:
    driver.quit()

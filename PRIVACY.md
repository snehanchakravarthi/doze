# Doze privacy policy

_Last updated: 16 October 2026_

Doze is a Chrome extension that puts tabs you aren't using to sleep so Chrome frees their memory. This policy explains what it handles and where that data goes.

## The short version

Doze does not collect, sell or share any data. It has no servers, accounts, analytics or tracking. Everything it handles stays in your browser on your device.

## What Doze uses, and why

| Data | Why | Where it stays |
| --- | --- | --- |
| Open tabs' titles, URLs, and when you last used them | To rank tabs, find duplicates and show the list | Read from Chrome when needed; not stored except as below |
| How often you switch to each site, and when you reopened a site soon after Doze slept it | So Doze sleeps sites you use often less eagerly | `chrome.storage.local` on your device; values fade out over days |
| Activity log (what Doze slept or closed, with tab titles and URLs, and how much memory it freed) | To show Activity and offer Undo | `chrome.storage.local`, last 300 entries |
| Your settings and the sites you keep awake | To remember your choices | `chrome.storage.local` |
| Your device's total and free memory, and CPU load | To show the memory gauge and measure savings | Read live; not stored except as freed-memory numbers in the activity log |

## Hunger meter (optional, off by default)

If you turn on the hunger meter, Doze asks Chrome for access to the sites you visit. It then runs a small script in each page ([`src/probe.ts`](src/probe.ts)) that reports only three things to Doze:

- how much memory the page's JavaScript uses
- how much long-running work the page does while it's in the background
- whether a text field you typed into still has text in it (yes or no)

It does not read, store or send the contents of pages or anything you type. It ignores password and search fields. Readings are kept in session storage for about a minute and are cleared when you turn the feature off, which also removes the site access.

## Sharing

Doze sends no data off your device. It makes no network requests.

## Deleting your data

To erase everything Doze has stored, remove the extension from Chrome.

## Contact

Questions or concerns: [open an issue](https://github.com/SnehanChakravarthi/doze/issues), or use the contact details on Doze's Chrome Web Store page.

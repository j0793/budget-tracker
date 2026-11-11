# Budget Tracker

A personal budget app that runs entirely in the browser. It works offline and installs to your phone's home screen.

- **Entries:** log income and expenses, then edit, search and filter them.
- **Money:** free cash after security deposits, an "every dollar's job" savings ladder, a cash forecast, interest on idle cash, a monthly checklist, and a mortgage tracker with extra-payment what-ifs.
- **Analytics:** a custom chart dashboard.
- **Work:** a shift calendar with hourly pay, a schedule, and a work log.
- **Import / Export:** CSV in and out, plus full JSON backups.

## Your data stays on your device

There is no server and no account. Everything is saved in your browser's storage (IndexedDB) on the device you use. The code in this repo is public, but your entries are never in it.

That means:
- **Each device has its own copy.** Use **Import / Export → Download full backup**, then **Import → Replace all** on another device, to move data.
- **Back up now and then.** Save the JSON backup somewhere safe, such as iCloud Drive or Google Drive. The app reminds you every two weeks.
- **On iPhone, add it to your Home Screen.** Safari can clear site data for sites you haven't visited in a while, and home-screen apps are exempt.

## Install on your phone

1. Open the site's URL in **Safari** (iPhone) or **Chrome** (Android).
2. iPhone: tap **Share → Add to Home Screen**. Android: tap **⋮ → Install app** (or **Add to Home screen**).
3. Open it from the home-screen icon. It runs full-screen and works without a signal.

## Hosting (GitHub Pages)

**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**. The site appears at `https://<username>.github.io/<repo>/` within a minute or two.

## Updating the app

After changing any file, bump `VERSION` in `sw.js` (for example `v1` → `v2`) so installed copies pick up the new version. Phones load the update in the background and use it the next time the app opens.

## Never commit personal data

`.gitignore` blocks the desktop version's data files (`transactions.csv`, `categories.json`, `dashboard.json`, `work.json`, `money.json`), downloaded backups and exports, and `budget.py`. Don't save backups into this folder, and don't force-add those files.

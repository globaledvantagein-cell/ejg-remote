// PM2 config. CommonJS is mandatory here — PM2 loads this file with require(),
// so it cannot be an ES module even though the rest of the project is.
//
// This app is a cron job, not a server: it runs once, drains all 9 ATS
// platforms, writes what it found, and exits. autorestart is therefore false —
// only cron_restart brings it back up.
module.exports = {
    apps: [
        {
            name: 'ejg-remote-scraper',
            script: 'src/index.js',
            // Daily at 07:00 UTC — one hour after the German scraper, so the two
            // never contend for the same MongoDB instance.
            cron_restart: '0 7 * * *',
            autorestart: false,
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};

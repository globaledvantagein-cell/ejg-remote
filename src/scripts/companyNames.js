// ─── Company name corpus ───────────────────────────────────────────────────────
//
// Source 2 of the discovery pipeline: a hand-curated list of tech companies that
// plausibly post English-language remote roles. Names are written as humans
// write them; discover-slugs.js derives the slug variants.
//
// Scoped to US / UK / CA / AU / IE / NZ / SG companies per the remote scraper's
// country whitelist. Kept in its own module so the discovery script stays
// readable.

export const COMPANY_NAMES = [
    // ─── Big tech and subsidiaries ─────────────────────────────────────────────
    'Google', 'Alphabet', 'YouTube', 'Waymo', 'Verily', 'DeepMind', 'Apple',
    'Meta', 'Facebook', 'Instagram', 'WhatsApp', 'Amazon', 'AWS', 'Twitch',
    'Audible', 'Zappos', 'Microsoft', 'LinkedIn', 'GitHub', 'Xbox', 'Netflix',
    'Nvidia', 'Intel', 'AMD', 'Qualcomm', 'Broadcom', 'Cisco', 'Oracle', 'IBM',
    'Dell', 'HP', 'Adobe', 'Salesforce', 'SAP', 'VMware', 'Uber', 'Lyft',
    'Airbnb', 'Tesla', 'SpaceX', 'PayPal', 'eBay', 'Yahoo', 'Pinterest',
    'Snap', 'Reddit', 'Discord', 'Spotify', 'Shopify', 'Block', 'Square',

    // ─── SaaS and enterprise software ──────────────────────────────────────────
    'HubSpot', 'Atlassian', 'Twilio', 'Zendesk', 'ServiceNow', 'Workday',
    'Splunk', 'Datadog', 'PagerDuty', 'New Relic', 'Dynatrace', 'AppDynamics',
    'Sumo Logic', 'Grafana Labs', 'Elastic', 'MongoDB', 'Redis', 'Couchbase',
    'Cockroach Labs', 'PlanetScale', 'Neon', 'Supabase', 'Firebase', 'Snowflake',
    'Databricks', 'Confluent', 'HashiCorp', 'Docker', 'Kubernetes', 'Rancher',
    'Puppet', 'Chef', 'Ansible', 'Terraform', 'Pulumi', 'Spacelift', 'Env0',
    'Asana', 'Monday', 'ClickUp', 'Notion', 'Coda', 'Airtable', 'Smartsheet',
    'Wrike', 'Basecamp', 'Trello', 'Jira', 'Linear', 'Shortcut', 'Height',
    'Slack', 'Zoom', 'Miro', 'Mural', 'Figma', 'Sketch', 'InVision', 'Canva',
    'Box', 'Dropbox', 'DocuSign', 'Adobe Sign', 'PandaDoc', 'Ironclad',
    'Coupa', 'Workato', 'Zapier', 'Make', 'Tray', 'Celigo', 'Boomi', 'MuleSoft',
    'Segment', 'Amplitude', 'Mixpanel', 'Heap', 'Pendo', 'FullStory', 'LogRocket',
    'Hotjar', 'Optimizely', 'LaunchDarkly', 'Split', 'Statsig', 'Eppo',
    'Contentful', 'Sanity', 'Storyblok', 'Strapi', 'Prismic', 'Webflow',
    'Squarespace', 'Wix', 'WordPress', 'Automattic', 'Ghost', 'Substack',

    // ─── Fintech ───────────────────────────────────────────────────────────────
    'Stripe', 'Plaid', 'Brex', 'Ramp', 'Mercury', 'Wise', 'Revolut', 'Monzo',
    'Starling Bank', 'Tide', 'Marqeta', 'Affirm', 'Klarna', 'Afterpay', 'Zip',
    'Chime', 'Varo', 'Dave', 'MoneyLion', 'SoFi', 'Robinhood', 'Webull',
    'Betterment', 'Wealthfront', 'Wealthsimple', 'Acorns', 'Stash', 'Public',
    'Carta', 'AngelList', 'Republic', 'Fundrise', 'Yieldstreet', 'Masterworks',
    'Gusto', 'Rippling', 'Deel', 'Remote', 'Oyster', 'Papaya Global',
    'Justworks', 'TriNet', 'Zenefits', 'Namely', 'BambooHR', 'Lattice',
    'Culture Amp', 'Leapsome', '15Five', 'Bonusly', 'Workhuman', 'Bill',
    'Expensify', 'Navan', 'Airbase', 'Spendesk', 'Pleo', 'Payhawk', 'Soldo',
    'Modern Treasury', 'Unit', 'Lithic', 'Highnote', 'Checkout', 'Adyen',
    'GoCardless', 'TrueLayer', 'Yapily', 'Tink', 'Alloy', 'Persona', 'Socure',
    'Sardine', 'Sift', 'Forter', 'Riskified', 'Signifyd', 'Chainalysis',

    // ─── AI and machine learning ───────────────────────────────────────────────
    'OpenAI', 'Anthropic', 'Cohere', 'Stability AI', 'Hugging Face', 'Scale AI',
    'Weights and Biases', 'LangChain', 'LlamaIndex', 'Pinecone', 'Weaviate',
    'Chroma', 'Qdrant', 'Milvus', 'Vespa', 'Runway', 'ElevenLabs', 'Synthesia',
    'Descript', 'Perplexity', 'Glean', 'Harvey', 'Sierra', 'Abridge', 'Cursor',
    'Anysphere', 'Codeium', 'Sourcegraph', 'Tabnine', 'Replit', 'Modal',
    'Together', 'Replicate', 'Baseten', 'Banana', 'Anyscale', 'Ray', 'Determined',
    'Domino Data Lab', 'DataRobot', 'H2O', 'Dataiku', 'Alteryx', 'Palantir',
    'C3 AI', 'Instabase', 'Hebbia', 'Writer', 'Jasper', 'Copy AI', 'Typeface',

    // ─── Crypto and web3 ───────────────────────────────────────────────────────
    'Coinbase', 'Kraken', 'Gemini', 'Circle', 'Paxos', 'Fireblocks', 'Anchorage',
    'BitGo', 'Alchemy', 'Infura', 'QuickNode', 'Thirdweb', 'Chainlink',
    'Uniswap', 'Aave', 'Compound', 'MakerDAO', 'Lido', 'EigenLayer',
    'Blockdaemon', 'Figment', 'Consensys', 'Ledger', 'Trezor', 'Magic Eden',
    'OpenSea', 'Blur', 'Dune', 'Nansen', 'Messari', 'Blockchain', 'Ripple',

    // ─── Developer tools and infrastructure ────────────────────────────────────
    'GitLab', 'Bitbucket', 'Vercel', 'Netlify', 'Railway', 'Render', 'Fly',
    'Heroku', 'DigitalOcean', 'Linode', 'Vultr', 'Cloudflare', 'Fastly',
    'Akamai', 'Bunny', 'Postman', 'Insomnia', 'Hoppscotch', 'RapidAPI', 'Kong',
    'Apollo', 'Hasura', 'PostHog', 'Retool', 'Appsmith', 'Budibase', 'Bubble',
    'CircleCI', 'Buildkite', 'Harness', 'Codefresh', 'Semaphore', 'Earthly',
    'Sentry', 'Rollbar', 'Bugsnag', 'Honeycomb', 'Lightstep', 'Chronosphere',
    'Cribl', 'Vector', 'Temporal', 'Inngest', 'Trigger', 'Prefect', 'Dagster',
    'Airbyte', 'Fivetran', 'Hightouch', 'Census', 'dbt Labs', 'Rudderstack',
    'Snowplow', 'Tailscale', 'Teleport', 'Doppler', 'Infisical', 'WorkOS',
    'Clerk', 'Stytch', 'Descope', 'Frontegg', 'Auth0', 'Okta', 'Ory',

    // ─── Cybersecurity ─────────────────────────────────────────────────────────
    'CrowdStrike', 'SentinelOne', 'Palo Alto Networks', 'Fortinet', 'Zscaler',
    'Netskope', 'Snyk', 'Veracode', 'Checkmarx', 'Semgrep', 'Socket',
    'Chainguard', 'Sysdig', 'Aqua Security', 'Lacework', 'Wiz', 'Orca Security',
    'Rapid7', 'Tenable', 'Qualys', 'Vanta', 'Drata', 'Secureframe', 'Sprinto',
    'OneTrust', 'BigID', 'Securiti', 'Transcend', 'Osano', 'Ketch', 'Jamf',
    'Kandji', 'Fleet', 'Huntress', 'Arctic Wolf', 'Expel', 'Red Canary',
    'Dragos', 'Claroty', 'Armis', 'Axonius', 'CyberArk', 'SailPoint', 'Delinea',
    '1Password', 'Bitwarden', 'Dashlane', 'Keeper Security', 'Proton',

    // ─── Commerce and marketplaces ─────────────────────────────────────────────
    'Etsy', 'Wayfair', 'Chewy', 'Instacart', 'DoorDash', 'Grubhub', 'Deliveroo',
    'Just Eat', 'Gopuff', 'Getir', 'Faire', 'Mercari', 'Poshmark', 'ThredUp',
    'StockX', 'GOAT', 'Depop', 'Vinted', 'Klaviyo', 'Attentive', 'Braze',
    'Iterable', 'Customer IO', 'Bloomreach', 'Algolia', 'Constructor', 'Bolt',
    'Fast', 'Recharge', 'Shogun', 'Gorgias', 'Loop Returns', 'Narvar', 'Route',
    'ShipBob', 'Flexport', 'Convoy', 'Project44', 'FourKites', 'Samsara',

    // ─── Health tech ───────────────────────────────────────────────────────────
    'Oscar Health', 'Ro', 'Hims', 'Headspace', 'Calm', 'Noom', 'Whoop', 'Oura',
    'Peloton', 'ClassPass', 'Mindbody', 'Zocdoc', 'Teladoc', 'Amwell',
    'Included Health', 'Omada Health', 'Lyra Health', 'Spring Health',
    'Cedar', 'Olive', 'Komodo Health', 'Tempus', 'Flatiron Health', 'Benchling',
    'Veeva', 'Doximity', 'Hinge Health', 'Sword Health', 'Carbon Health',

    // ─── Media, education, and consumer ────────────────────────────────────────
    'Duolingo', 'Coursera', 'Udemy', 'Udacity', 'Skillshare', 'MasterClass',
    'Khan Academy', 'Chegg', 'Quizlet', 'Brilliant', 'DataCamp', 'Pluralsight',
    'Codecademy', 'Grammarly', 'Loom', 'Vimeo', 'Wistia', 'Brightcove',
    'Patreon', 'Kickstarter', 'Indiegogo', 'Gumroad', 'Teachable', 'Thinkific',
    'Kajabi', 'Circle', 'Discourse', 'Bumble', 'Hinge', 'Match', 'Tinder',

    // ─── UK, Canadian, Australian, Irish, Singaporean tech ─────────────────────
    'Monzo Bank', 'Octopus Energy', 'Darktrace', 'Improbable', 'Babylon Health',
    'Zopa', 'OakNorth', 'Thought Machine', 'Form3', 'ClearBank', 'Cleo',
    'Freetrade', 'Trading 212', 'Moneybox', 'Nutmeg', 'Onfido', 'ComplyAdvantage',
    'Quantexa', 'Featurespace', 'Tessian', 'Snyk UK', 'Beamery', 'Hopin',
    'Lightspeed', 'Clio', 'Hootsuite', 'Later', 'Jobber', 'Dialpad', 'Vidyard',
    'Ada', 'Coveo', 'Kinaxis', 'Docebo', 'Thinkific Labs', 'Wealthsimple Tech',
    'SafetyCulture', 'Culture Amp AU', 'Deputy', 'Employment Hero', 'Airwallex',
    'Judo Bank', 'Athena', 'Immutable', 'Linktree', 'Go1', 'Cover Genius',
    'Intercom', 'Workhuman Ireland', 'Flipdish', 'Wayflyer', 'LetsGetChecked',
    'Grab', 'Sea Group', 'Carousell', 'Ninja Van', 'Nium', 'Thunes', 'Coda Payments',

    // ─── European scale-ups ────────────────────────────────────────────────────
    // Recruitee, Teamtailor and Personio are EU-centric platforms and the list
    // above is US-heavy, so these exist mainly to give those three something to
    // match on. Their HQs sit outside the US/UK/CA/AU/IE/NZ/SG whitelist, but
    // index.js filters every posting on country regardless of who posted it —
    // so a Berlin company's US-remote role still qualifies, and its Berlin roles
    // are rejected exactly as they are today.
    'Spotify', 'Klarna', 'iZettle', 'Tink', 'Trustly', 'Truecaller', 'Sinch',
    'Kry', 'Mentimeter', 'Epidemic Sound', 'Northvolt', 'Einride', 'Voi',
    'Budbee', 'Instabox', 'Tobii', 'Storytel', 'Bambuser', 'Fishbrain',
    'Oda', 'Vipps', 'Cognite', 'Remarkable', 'Kahoot', 'Gelato', 'Unacast',
    'Xeneta', 'Autostore', 'Visma', 'Tomra', 'Kongsberg',
    'Pleo', 'Lunar', 'Templafy', 'Siteimprove', 'Zendesk Denmark', 'Corti',
    'Tradeshift', 'Famly', 'GoMore', 'Podimo', 'Dixa', 'Peakon',
    'Wolt', 'Supercell', 'Rovio', 'Relex', 'Aiven', 'Swappie', 'Oura Health',
    'Adyen', 'Mollie', 'Booking', 'Picnic', 'Backbase', 'Bynder', 'Channable',
    'Bird Amsterdam', 'MessageBird', 'Framer', 'Miro Amsterdam', 'Optiver Amsterdam',
    'Personio', 'Celonis', 'N26', 'Trade Republic', 'Taxfix', 'Raisin',
    'GetYourGuide', 'HelloFresh', 'Zalando', 'Delivery Hero', 'Flix', 'SumUp',
    'Wayfair Berlin', 'Contentful', 'Babbel', 'DeepL', 'Parloa', 'Helsing',
    'Forto', 'Enpal', 'Moss', 'Upvest', 'Billie', 'Solaris', 'Mambu',
    'Choco', 'Grover', 'Kry Berlin', 'Ada Health', 'Amboss', 'Doctolib',
    'Alan', 'Qonto', 'Swile', 'PayFit', 'Spendesk', 'Contentsquare', 'Dataiku',
    'Mirakl', 'Algolia', 'Sorare', 'Ledger France', 'Back Market', 'ManoMano',
    'Doctolib France', 'Younited', 'Lydia', 'Shift Technology', 'Ivalua',
    'TravelPerk', 'Factorial', 'Glovo', 'Cabify', 'Wallapop', 'Typeform',
    'Red Points', 'Holded', 'Cobee', 'Amenitiz', 'Jobandtalent', 'Devo',
    'Satispay', 'Scalapay', 'Bending Spoons', 'Musixmatch', 'Casavo',
    'Bitpanda', 'GoStudent', 'Storyblok', 'Refurbed', 'Prewave', 'Anyline',
    'Frontify', 'Scandit', 'Nexthink', 'Sonar', 'Ledgy', 'Yokoy', 'Proton AG',
    'Rohlik', 'Productboard', 'Kiwi', 'Mews', 'Twisto', 'Behavox',
    'Bolt Estonia', 'Wise Estonia', 'Veriff', 'Pipedrive', 'Glia', 'Starship',
    'Vinted', 'Kilo Health', 'Nord Security', 'Omnisend', 'Whatagraph',
    'Docplanner', 'Brainly', 'Booksy', 'Packhelp', 'Ramp Network', 'Sunroof',

    // ─── Recruitee-leaning names ───────────────────────────────────────────────
    // Recruitee is a Dutch product whose customer base is overwhelmingly EU
    // SMBs, so the US/YC corpus barely touches it. These are Benelux/DACH
    // scale-ups and mid-market names of the size that actually buys Recruitee.
    'Limehome', 'Catawiki', 'Usabilla', 'Sendcloud', 'Otrium', 'Bloomon',
    'Homerun', 'Studocu', 'Lightyear', 'VanMoof', 'Swapfiets', 'Dott',
    'Felyx', 'Cloudnine', 'Blendle', 'Peerby', 'Tiqets', 'Guerrilla Games',
    'Nmbrs', 'Silverfin', 'Teamleader', 'Showpad', 'Deliverect', 'Lighthouse',
    'Intigriti', 'Henchman', 'Odoo', 'Collibra', 'Sentiance', 'Unifiedpost',
    'Bizzy', 'Cowboy', 'Yuki', 'Robovision', 'Materialise', 'Barco',
    'Zeeguu', 'Mollie Payments', 'Adyen NL', 'Backbase NL', 'Bynder NL',
    'MessageBird NL', 'Framer NL', 'Picnic NL', 'Coolblue', 'Bol',
    'Takeaway', 'Just Eat Takeaway', 'Booking Holdings', 'TravelBird',
    'WeTransfer', 'Elastic NL', 'Optiver NL', 'Flow Traders', 'IMC Trading',
    'Adevinta', 'Marktplaats', 'Funda', 'Pararius', 'Rabobank', 'Bunq',
    'Knab', 'Moneyou', 'Payvision', 'Buckaroo', 'Pay', 'Multisafepay',
    'Ebury', 'Ohpen', 'Five Degrees', 'Topicus', 'Afas', 'Exact',
    'Unit4', 'Visma NL', 'Centric', 'Ordina', 'Sopra Steria', 'Conclusion',
    'Xebia', 'Info Support', 'Luminis', 'Codestar', 'Kabisa', 'Enrise',
    'Label305', 'Voormedia', 'Q42', 'Mirabeau', 'iO', 'Valtech',
    'Greenhouse Group', 'Dept', 'Fonk', 'Achmea', 'Aegon', 'NN Group',
    'Nationale Nederlanden', 'ASR', 'Menzis', 'CZ', 'VGZ', 'Zilveren Kruis',
    'Picnic Technologies', 'Bird Global', 'Tikkie', 'ABN AMRO', 'ING',

    // ─── Second expansion wave ─────────────────────────────────────────────────
    // Mid-market and scale-up names across the sectors that actually post remote
    // engineering, data, design and go-to-market roles. Weighted to US/UK/CA/AU
    // since those clear the country whitelist.

    // Data / analytics / ML infrastructure
    'Sigma Computing', 'Mode Analytics', 'Preset', 'Metabase', 'Lightdash',
    'Cube', 'Omni Analytics', 'Zenlytic', 'Hex', 'Deepnote', 'Noteable',
    'Starburst', 'Dremio', 'Firebolt', 'SingleStore', 'Timescale', 'ClickHouse',
    'QuestDB', 'InfluxData', 'Materialize', 'RisingWave', 'Decodable', 'Redpanda',
    'StreamNative', 'Upsolver', 'Estuary', 'Meroxa', 'Striim', 'Arcion',
    'Monte Carlo Data', 'Bigeye', 'Metaplane', 'Soda Data', 'Great Expectations',
    'Datafold', 'Sifflet', 'Anomalo', 'Validio', 'Elementary Data',
    'Atlan', 'Select Star', 'Castor', 'Secoda', 'Stemma', 'Acryl Data',
    'Alation', 'Collibra Data', 'Immuta', 'Satori Cyber', 'Privacera',

    // Developer tooling and platform engineering
    'Warp Terminal', 'Fig', 'Zed Industries', 'JetBrains', 'Nova',
    'Coder', 'Gitpod', 'Codespaces', 'Devbox', 'Jetify', 'Nixpacks',
    'Railway App', 'Northflank', 'Porter Run', 'Qovery', 'Zeet', 'Release Hub',
    'Garden', 'Okteto', 'Tilt', 'Skaffold', 'Argo Project', 'Flux CD',
    'Spacelift', 'Env0', 'Scalr', 'Terrateam', 'Digger', 'Atlantis',
    'Kubecost', 'Vantage', 'CloudZero', 'Finout', 'Zesty', 'Cast AI',
    'Loft Labs', 'Rafay', 'Spectro Cloud', 'Giant Swarm', 'Mirantis',
    'Ambassador Labs', 'Solo io', 'Tetrate', 'Buoyant', 'Traefik Labs',
    'Nginx', 'HAProxy', 'Varnish Software', 'Fastly Edge', 'Section',

    // Security
    'Abnormal Security', 'Material Security', 'Sublime Security', 'Nudge Security',
    'Push Security', 'Savvy Security', 'Valence Security', 'Obsidian Security',
    'AppOmni', 'Adaptive Shield', 'Wing Security', 'Reco AI', 'DoControl',
    'Cyera', 'Sentra', 'Dig Security', 'Laminar Security', 'Flow Security',
    'Oligo Security', 'Upwind Security', 'Sweet Security', 'Miggo',
    'Legit Security', 'Cycode', 'Arnica', 'Jit', 'Ox Security', 'Apiiro',
    'Backslash', 'Myrror', 'Kodem', 'Endor Labs', 'Phylum', 'Chainguard Labs',
    'Astrix Security', 'Entro Security', 'Oasis Security', 'Clutch Security',
    'Silverfort', 'Oort', 'Permiso', 'Push', 'Island Browser', 'Talon Cyber',
    'Seraphic', 'LayerX', 'Menlo', 'Netcraft', 'Cyren', 'Bolster',

    // Fintech and payments
    'Column Bank', 'Increase', 'Lead Bank', 'Treasury Prime', 'Synctera',
    'Bond Financial', 'Rize Money', 'Solid Financial', 'Unit Finance',
    'Moov Financial', 'Dwolla', 'Astra Finance', 'Method Financial',
    'Pinwheel', 'Argyle', 'Atomic Financial', 'Truv', 'Finch API',
    'Codat', 'Rutter', 'Merge Dev', 'Apideck', 'Nango', 'Paragon',
    'Stedi', 'Nylas', 'Knock', 'Courier', 'Novu', 'Loops', 'Resend Email',
    'Postmark', 'Mailgun', 'Customer', 'Klaviyo Data', 'Ortto', 'Encharge',

    // Vertical SaaS and marketplaces
    'ServiceTitan', 'Jobber Software', 'Housecall Pro', 'Workiz', 'Skedulo',
    'Procore', 'BuildOps', 'Buildertrend', 'Fieldwire', 'PlanGrid',
    'Toast', 'Lightspeed Commerce', 'SpotOn', 'Olo', 'Slice', 'ChowNow',
    'Restaurant365', 'MarginEdge', 'Crunchtime', 'Lineup', 'Sling',
    'Mindbody Wellness', 'Boulevard', 'Vagaro', 'Fresha', 'Booksy Pro',
    'Zenoti', 'Phorest', 'Treatwell', 'Timely', 'Kitomba',
    'Guesty', 'Hostaway', 'Lodgify', 'Cloudbeds', 'Mews Systems', 'Apaleo',
    'Duetto', 'IDeaS', 'RoomRaccoon', 'SiteMinder', 'Little Hotelier',

    // HR, legal, finance ops
    'Ashby HQ', 'Greenhouse Software', 'Lever Talent', 'SmartRecruiters Inc',
    'Workable Software', 'Teamtailor AB', 'Personio SE', 'Recruitee BV',
    'Gem Recruiting', 'Findem', 'Fetcher', 'HireEZ', 'SeekOut', 'Dover Careers',
    'Metaview', 'BrightHire', 'Hume AI', 'Karat Interview', 'CoderPad',
    'CodeSignal', 'Woven Teams', 'Byteboard', 'Otta Jobs', 'Welcome Jungle',
    'Ironclad Contracts', 'LinkSquares', 'Evisort', 'Lexion', 'Spellbook',
    'Clio Legal', 'Smokeball', 'MyCase', 'Filevine', 'CASEpeer', 'Litify',
    'Pilot Bookkeeping', 'Bench Accounting', 'Puzzle Financial', 'Digits',
    'Mercury Banking', 'Rho Business', 'Arc Technologies', 'Capchase',
    'Pipe Technologies', 'Founderpath', 'Vitt', 'Uncapped', 'Wayflyer Capital',

    // Healthcare and biotech tooling
    'Datavant', 'Truveta', 'Verana Health', 'Aetion', 'OM1', 'Atropos Health',
    'Medable', 'Science 37', 'Curebase', 'Reify Health', 'Paradigm Trials',
    'Unlearn AI', 'Owkin', 'Insitro', 'Recursion', 'Isomorphic Labs',
    'BenchSci', 'Deep Genomics', 'Cradle Bio', 'Cellarity', 'Generate Biomedicines',
    'Latch Bio', 'Form Bio', 'Watershed Bio', 'Seqera', 'Terra Bio',
    'Sema4', 'Color Genomics', 'Invitae', 'Myriad Genetics', 'Natera',

    // Climate and energy
    'Watershed Climate', 'Persefoni', 'Sweep Carbon', 'Plan A', 'Normative',
    'Greenly', 'Sinai Technologies', 'CarbonChain', 'Emitwise', 'Altruistiq',
    'Patch Technology', 'Cloverly', 'Pachama', 'Sylvera', 'BeZero',
    'Arcadia Power', 'David Energy', 'Octopus Energy Tech', 'Kraken Technologies',
    'Uplight', 'Bidgely', 'Sense Labs', 'Span Io', 'Lunar Energy',
    'Enode', 'Wattbuy', 'Ohmconnect', 'Voltus', 'Leap Energy', 'Piclo',

    // Education, media, community
    'Multiverse', 'Guild Education', 'BetterUp', 'Sana Labs', 'Docebo Learn',
    'Learnerbly', 'Go1 Learning', 'Kahoot Education', 'Quizizz', 'Nearpod',
    'Newsela', 'Amplify Education', 'Age of Learning', 'Outschool', 'Prodigy',
    'Skiff', 'Ghost Foundation', 'Beehiiv Media', 'ConvertKit Creators',
    'Buttondown', 'Curated', 'Letterdrop', 'Copy AI Content', 'Descript Media',
    'Riverside FM', 'Streamyard', 'Restream', 'Castos', 'Transistor FM',
    'Buzzsprout', 'Simplecast', 'Chartable', 'Podscribe', 'Magellan AI',
];

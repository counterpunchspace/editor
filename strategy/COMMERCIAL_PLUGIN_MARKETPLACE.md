# Commercial Plugin Marketplace

## Decision

Every plugin, free or commercial, registers through the Counterpunch GitHub App. The website imports each release into a private R2 wheel store, runs a static check, then a dynamic preflight in a disposable container with no network and hard time limits. The creator clicks Publish. The Plugin Manager lists only the website registry.

Preview and production share `context_users`, the wheel bucket, the GitHub App, and one plugins Worker. Staging is separate, including Stripe test mode. A plugin registered on preview is already a production record.

Commercial prices are EUR before tax. After tax and the Stripe fee, the creator receives 70% and Counterpunch keeps 30%. Payouts go through Stripe Connect. Buyers can refund within 14 days, capped at 3 self-serve refunds per 12 months.

The notes below are the earlier analysis. Where they disagree with this decision, this decision wins.

## Why the original plan does not hold

The first sketch kept commercial plugins on GitHub, the same way as free
plugins, with these extra rules:

- The repository must be private.
- At registration, an access token is stored on the creator's Counterpunch
  account.
- The Plugin Manager still discovers every plugin through the website's GitHub
  code-search API.
- Download waits until purchase.
- Counterpunch keeps 30%. Stripe pays the rest to the creator.
- Creators enter payout details on the website.
- Logged-in users who have a payment method on the website can buy from the
  Plugin Manager.

Purchases, the 30% fee, and creator payouts are feasible. They are new billing
beside membership, built with Stripe Connect. Private-repository discovery
through the current GitHub catalog is not.

A later variant gave the Counterpunch GitHub account read access to each
private repository, so the existing catalog token could see them. The search
call can return those repositories. The Plugin Manager still cannot list the
plugin, and opening that access on the current download route would publish
the private wheels to every editor visitor.

Metadata and price have to be entered on the website anyway, so discovery was
never going to be fully automatic. Registration is a website listing plus the
wheel file.

## What free plugins do today

Font Destination plugins are the catalog this decision is measured against.

The Plugin Manager calls `GET /api/github/code-search` with a fixed marker
query (`counterpunch-plugin:font-destination:v1` in
`counterpunch-plugin.json`). The website runs GitHub's legacy
`GET /search/code` with one server secret, `GITHUB_PLUGIN_CATALOG_TOKEN`. The
route checks the editor Origin header and caches successful responses as
public for 15 minutes.

The editor then loads each manifest from `raw.githubusercontent.com` and lists
`releases/latest` from `api.github.com`, both without a token. Wheel bytes
come back through `GET /api/github/release-asset`, which uses the same catalog
token, the same Origin check, and `Cache-Control: public, max-age=900`.

Install tells the user to check that the repository is public when the release
listing fails. A private manifest URL and a private release listing both fail
closed for an anonymous client.

## Private GitHub access

If the Counterpunch GitHub account has read access, and the catalog token has
private-repository contents permission, `GET /search/code` can return those
private repositories. Collaborator read access counts. GitHub's limits on that
legacy search:

- At most 4,000 private repositories are searchable: the most recently updated
  among the first 10,000 private repositories that account can access.
- Only the default branch is indexed, and only files under 384 KB.
- A repository with no activity in the last year, or an archived repository,
  drops out.
- A repository can be missing until GitHub indexes it after access is granted.
- The endpoint allows 10 requests per minute.

That is enough for a search hit. It is not enough for discovery. The manager
treats the hit as a path, then fetches `counterpunch-plugin.json` from
`raw.githubusercontent.com` with no token. A private file 404s, and the
manager skips it. The in-browser release listing fails the same way.

Using the current routes with that shared token would also remove the access
boundary. Origin is not a purchase check. Any visitor of the editor could
search the private repositories the token can read, and
`/api/github/release-asset` could download their release wheels into the
public cache. The code-search query is caller-controlled. The website strips
file bodies from the search response and still returns repository paths.

A token stored on the creator's account does not fix the search. The catalog
request sends one `Authorization` header. Per-creator tokens cannot be merged
into that call. A pasted personal access token is also a poor secret: fine-
grained tokens expire, classic tokens are often broader than one repository,
D1 is not a secret store, and possession of a token does not prove the
Counterpunch user owns the repository.

GitHub will not keep a repository private. The website can refuse a listing
that is public at check time. The creator can make it public later, and the
release is then downloadable from GitHub.

## Registration model

A creator registers a commercial plugin on the website.

1. The creator completes Stripe payout onboarding. A paid listing can be
   published only after Stripe reports that payouts are enabled.
2. The creator sets the fields the catalog has to own: name, description,
   price, preview image, support link, and plugin id.
3. The creator uploads the `.whl`. The site computes the SHA-256. There is no
   separate checksum file.
4. The site stores the wheel in a private R2 bucket and the listing, version,
   price, hash, creator, and connected account in D1. The object is not
   publicly readable.
5. Before the listing is published, the site checks that the upload is a wheel
   and that its entry point matches the listing's plugin id. A failed check
   stays a draft.

The file is the wheel the editor already installs for a free plugin. A zip of
the repository is not a plugin package. Pyodide installs the wheel, and a
source archive would add an unpack step without giving the editor anything it
can load.

A new version is a new wheel upload on the same listing. Anyone who already
bought the plugin can download the latest version. A price change applies to
future purchases.

The Plugin Manager asks the website for commercial listings and shows the
public fields only: name, description, price, preview, and plugin id. The
response does not include a storage URL or the wheel bytes.

## Purchase and payout

A logged-in user buys from the Plugin Manager. The charge is a one-time
payment on a Stripe customer that can exist without a membership. Today a
Stripe customer is created only when someone starts a membership, and that
card was saved for the subscription. Plugin purchases need their own customer,
including for people who are not members.

A saved card will not always charge silently. European banks can require the
buyer to confirm the payment on session. The purchase flow confirms on session
when the saved card is declined for an off-session charge.

The charge is a Stripe Connect destination charge. The buyer pays
Counterpunch. The application fee is 30%. Stripe transfers the remainder to
the creator's connected account and pays their bank on Stripe's payout
schedule. Membership charges stay platform charges on Counterpunch's own
products. Marketplace charges are a separate flow.

Creators do not type bank details into Counterpunch. Stripe's embedded
onboarding collects identity, bank, and tax details. The website stores the
connected-account id.

Card processing fees come out of Counterpunch's side on this charge pattern.
A 30% fee covers them at normal plugin prices. A €1 plugin can leave
Counterpunch with nothing after processing, so the listing needs a minimum
price that clears the processing fee.

The website writes the purchase row from the Stripe webhook, not from the
browser's return URL. Refunds reverse the creator's transfer. A dispute after
the creator has been paid out to their bank can leave Counterpunch holding
the loss.

## Download

`GET` of the wheel is a logged-in website request. The handler checks the
session and the purchase row, then streams the object from R2. The response
is not publicly cached and does not redirect to a storage URL the buyer can
reuse or share.

The editor verifies the SHA-256 and installs the wheel into the Settings
Folder `Plugins/` directory, the same way it installs a free plugin's release
wheel.

## What the shield covers

The shield is the download. The website can refuse the bytes to someone who
has not purchased the plugin.

After a purchase, the wheel is a file in the user's Plugins folder. Startup
reinstalls every wheel in that folder into Pyodide with no account check.
Someone who receives the file can install it. A license check inside the
wheel runs on the client and can be removed.

For a Font Destination plugin, the receiver URL is listing metadata. Hiding
the wheel does not hide the destination site. Gating that site is a separate
product decision for the creator.

## Free plugins

Public GitHub discovery stays as it is for free plugins: code search, a public
manifest, and a public release wheel through the existing website proxy.
Commercial rows are added to the Plugin Manager from the website catalog.
They do not enter `GITHUB_PLUGIN_CATALOG_TOKEN`'s search, and that token does
not gain access to creator repositories.

## Later: import from a GitHub release

A creator who already cuts wheels as GitHub releases may later connect a
repository so the website can copy one release wheel into R2 at publish time.
That copy is the published artifact. Buyers still download from the website.
The catalog still comes from D1. The Counterpunch GitHub account still does
not need standing read access for discovery.

That import is a publishing convenience. It is not required for the first
marketplace.

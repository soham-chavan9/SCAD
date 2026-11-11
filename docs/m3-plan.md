# M3 plan: share a website with a link

Written for the founder. The engineering version of each step is in
`TASKS.md` (M3).

## What SCAD is, in one line

Build a website on your laptop, and send friends a link to it, with no
hosting setup. SCAD keeps a hosted copy, so the link keeps working when your
laptop is off.

## The flow we are building

1. **Vibe code** a website with Claude Code (or Cursor).
2. **Tell your AI:** *"Publish this and share it with sam@gmail.com."* SCAD
   publishes the folder on your laptop. Publishing straight from GitHub comes
   in M4.
3. **Get a link.** Your friend opens the `https://` link on any phone or
   laptop, signs in with a code sent to their email, and sees the site.

## Scope: every kind of website

"Website" in M3 means anything people visit in a browser to look at, read,
or click around, whatever tool built it:

| Kind | Examples | M3 |
|---|---|---|
| Plain pages | HTML, CSS, JavaScript files | Yes |
| Modern site builders | React, Vite, Vue, Svelte, Solid, Preact, Angular, Create React App | Yes |
| Content and docs sites | Astro, Gatsby, Docusaurus, VitePress, Eleventy, Hugo, Jekyll | Yes |
| Server-rendered sites | Next.js, Nuxt, SvelteKit, Remix, Astro with a server | Yes |
| Apps with a backend | Saves data, user accounts, APIs (Express, Flask, Django), PHP/WordPress | Later (M4) |

## The plan: six stages, each ends with something you can try

### Stage 1. A link that works for anyone
SCAD moves from your laptop to a free, always-on server on the internet.
- **You'll try:** open a sample website's link on your phone over mobile
  data, sign in with the emailed code, and see it.
- **Your part (about 20 minutes, I'll walk you through it):** create a free
  Oracle Cloud account (it asks for a card to check you're real; the free
  tier doesn't charge), claim a free web address on DuckDNS, and make a
  Gmail app password so SCAD can send sign-in emails.

### Stage 2. Every static website builds
SCAD recognises the site builders above, downloads the add-on packages they
need in a separate locked-down step, builds the site with no internet
access, and serves the finished pages.
- **You'll try:** ask Claude for a new React site and a docs site, publish
  both untouched, and open the links.

### Stage 3. Server-rendered websites
Next.js, Nuxt, SvelteKit, Remix and Astro sites that need a small server to
render pages run as-is.
- **You'll try:** ask Claude for a Next.js site and publish it untouched.

### Stage 4. Publish by asking
One pasted command sets SCAD up inside Claude Code. After that you only
talk to your AI. Errors are in plain English, so your AI can usually fix
them on its own.
- **You'll try:** on a second laptop (or a friend's), start from nothing,
  follow a one-page guide, and send yourself a working link.

### Stage 5. Private or public link
When you publish, your AI asks: *"Private (only people you share with) or
public (anyone with the link)?"* If you don't say, it's private.
- **Private (default):** friends confirm their email once, then see the site.
  A forwarded link doesn't work for strangers.
- **Public:** anyone with the link sees the site right away, no sign-in.
  Search engines are asked not to list it.
- You can switch a site either way at any time.
- **You'll try:** publish one site each way and open both from a phone that
  isn't signed in.

### Stage 6. Undo
*"That update broke it, go back"* restores the previous version in one step.
- **You'll try:** publish a broken change on purpose, then undo it.

## Timing: built overnight, finished with you

All the code for stages 1 to 6 is built and tested on this Mac overnight
(Nov 11), each stage as its own change for you to approve. Three things
need you in the morning and can't be done overnight:
1. The Stage 1 sign-ups (Oracle, DuckDNS, Gmail), then I put SCAD on the
   free server.
2. The phone check and the second-laptop check.
3. Approving (merging) each change.

Cost: $0.

## Later

- **M4, apps with a backend and GitHub:** API servers (Node, Python), apps
  that save data and nightly backups of it, PHP/WordPress, and publishing
  from a GitHub repo link (*"Publish github.com/you/my-site"*).
- **Afterwards:** Google sign-in for friends, security scanning, a paid host
  when the free one is outgrown, and a real web address (about $10 a year).

## Decisions I made as CTO

| Decision | Why |
|---|---|
| **SCAD hosts a copy** (not a live tunnel to your laptop) | The link keeps working when your laptop is off. Live tunnels already exist for free, so they're not where we can stand out |
| **Every kind of website in M3, backend apps in M4** | Covers whatever tool you or your AI picks for a site, while keeping data-saving apps (and their backups) for later |
| **Free Oracle Cloud server**, with your Mac as the backup | The only free option that's always online and can run the extra app sandbox (gVisor) we couldn't test on your Mac |
| **Free DuckDNS address** to start | Free, and it can get proper `https` certificates. Switching to a real domain later is a settings change |
| **Gmail for sign-in emails** | Free, about 500 emails a day, which is plenty for a few friends |
| **Talking to your AI is the main way to use SCAD** | That's how you already work. The terminal is there, but you never need it |
| **GitHub publishing in M4** | Your AI already has the code on your laptop, so M3 publishes from there. GitHub is an extra path, not a step you need |
| **Private link by default, public if you choose** | Your sites stay private unless you decide otherwise, and a public link takes one word to your AI |
| **Only you publish; friends view** | Keeps the first public version simple and safe |
| **Packages download in a separate, locked-down step** | Sites get what they need to build, but untrusted code never gets internet access during the build |

## Risks and what we'll do about them

| Risk | Plan |
|---|---|
| Oracle has no free server, or takes back an idle one | Fall back to your Mac (needs a home router that allows outside visitors; dorm Wi-Fi usually doesn't) |
| A website needs a package with special build steps | The error names the package and suggests a swap your AI can make |
| A free `duckdns.org` link looks less trustworthy | Buy a real domain when you're ready; nothing else changes |
| A public link gets shared widely or hammered by bots | Public sites are rate-limited, and you (as operator) can switch any site off in seconds |
| Gmail limits or flags the sign-in emails | Switch to a free email-sending service once we have a real domain |

## What I need from you

1. A yes on this plan.
2. About 20 minutes for the Stage 1 sign-ups. You enter the card, passwords
   and app password yourself; I never handle them.

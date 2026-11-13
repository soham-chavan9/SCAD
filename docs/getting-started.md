# Getting started: share your website with a link

This guide is for you if you build websites with an AI (Claude Code or
Cursor) and want to send a friend a link to one. You paste **one command**
once. After that you only talk to your AI.

You need:

- A Mac or Linux laptop with **Claude Code** or **Cursor** installed.
- **Node.js 22 or newer.** If you're not sure, skip ahead: the command below
  tells you if it's missing. To install it, go to <https://nodejs.org> and
  click the big **LTS** button.
- The **address of your SCAD**, e.g. `myscad.duckdns.org`. The person who
  runs SCAD gives you this (if that's you: `docs/deploy.md`).
- Your **email address** that SCAD knows (the operator's email).

## 1. Paste one command

Open the **Terminal** app (on a Mac: press ⌘ Space, type *Terminal*, press
Return). Paste this line, replacing the two marked parts, and press Return:

```bash
curl -fsSL https://api.myscad.duckdns.org/install.sh | sh -s -- --email you@example.com
```

- `myscad.duckdns.org` → your SCAD's address.
- `you@example.com` → your email.

What happens:

1. It downloads SCAD (one file, into a hidden folder `~/.scad`).
2. It shows a code like `7F3A-9C21` and emails you.
3. Open that email, check that the code is the same one, and press
   **Approve**. The Terminal says **Logged in.**
4. It adds SCAD to Claude Code and to Cursor, and says **All set.**

Close the Terminal, then **quit and reopen Claude Code** (or Cursor) so it
picks SCAD up.

## 2. Publish by asking

Open your website's folder in Claude Code and say:

> Publish this with SCAD and share it with sam@gmail.com

Your AI will ask:

> Should this be **private** (only people you share it with) or **public**
> (anyone with the link)?

- **Private** (the default, if you don't say): only the people you share it
  with can open it. Sam gets an email with the link. The first time, Sam types
  their email on the sign-in page and clicks the link SCAD sends them. A
  forwarded link doesn't work for strangers.
- **Public**: anyone with the link sees the site right away, no sign-in.
  Search engines are asked not to list it.

Your AI tells you the link, for example
`https://my-site.you.myscad.duckdns.org`, and which kind it is.

## 3. Things you can ask

| Say | What happens |
|---|---|
| "Publish this with SCAD" | Puts the folder online, or updates it |
| "Share it with kim@example.com" | Kim gets an email with the link |
| "Stop sharing with kim@example.com" | Kim can't open it any more (within seconds) |
| "Publish it again as public" / "...as private" | Switches the kind of link; you can switch any time |
| "That update broke it, go back" | Brings back the previous version in one step |
| "What sites do I have on SCAD?" | Lists your sites and links |
| "Delete the old site" | Removes it and its saved data (your AI asks first) |

## If something goes wrong

Your AI sees SCAD's error messages, which say what to do next, so usually
it fixes things by itself. If it asks you to do something:

- **"Not logged in"**: open Terminal and run
  `~/.scad/bin/scad login --email you@example.com`, then press **Approve** in
  the email.
- **"needs Node.js 22 or newer"**: install it from <https://nodejs.org>
  (LTS), then paste the command from step 1 again.
- **No email arrived**: check spam, wait a minute, then paste the step 1
  command again (use the newest email; older links stop working).
- **"Claude Code isn't installed here"**: install Claude Code, then paste
  the step 1 command again. It's safe to run as often as you like.
- **A friend can't sign in**: make sure you shared with the exact email they
  type on the sign-in page.

## What SCAD can publish today

Plain HTML sites and sites with a `Dockerfile` work now. Sites built with
React, Vue, Svelte, Next.js and other site builders are being added (M3
stages 2 and 3). Apps that save data or have their own server code come
later (M4).

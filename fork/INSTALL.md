# Install the fork

Install a build from [Alb11747/t3code releases](https://github.com/Alb11747/t3code/releases)
once, then use the desktop app's **Install update** button for future fork releases.
You do not need to clone the repository, build anything, or set up the sync
workflow on each computer.

## Choose a download

Open the releases page and expand **Assets** on the newest published nightly.
These releases are marked **Pre-release**; use the releases list rather than
GitHub's `/releases/latest` link, which looks for a stable release.

| Computer                     | Download                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Windows, Intel or AMD 64-bit | `T3-Code-<version>-x64.exe`                                                                           |
| Linux, Intel or AMD 64-bit   | `T3-Code-Nightly-x86_64.AppImage`                                                                     |
| Android, ARM64 phone         | `T3-Code-Fork-Android-arm64.apk` from an **Android** release.                                         |
| macOS or an ARM computer     | No native fork build is published; use [browser access](#browser-access-on-macos-or-other-computers). |

The `.blockmap` and `.yml` files support automatic updates; you do not need to
download them. The `t3-...` archives are command-line servers, not desktop apps.

Official downloads, `winget`, Homebrew, `npx t3`, and the installer at `t3.codes`
install upstream T3 Code. Switching an official app to Nightly also keeps its
upstream update feed. To receive this fork's updates, install its download first.

## Android

1. Open [fork releases](https://github.com/Alb11747/t3code/releases) on the phone
   and choose the newest **T3 Code Fork Android** release (`android-fork-…`).
2. Download **T3-Code-Fork-Android-arm64.apk**, open it and allow installation
   from your browser or file manager when Android asks.
3. Open **T3 Code Fork** and connect to the T3 server that runs your agents.
   The phone controls that server; it does not run providers itself.

This standalone APK supports ARM64 phones on Android 7 or newer and does not
need Expo Go or a development server. It installs beside upstream T3 Code with
separate saved connections and settings. Native Google sign-in and push
notifications are not verified for this fork's signing identity; direct server
pairing is available.

Fork updates download automatically at launch and after four hours when returning to the app. A downloaded update opens Android’s installer on the next launch; Android may first ask you to allow updates from T3 Code Fork. **Settings → About** shows update status, **Check now**, and **Install now**. Installation requires Android confirmation.

To update manually, download a newer fork APK and install it over **T3 Code
Fork** without uninstalling; its saved data remains. Android asks you to confirm
the installation. Upstream Expo updates are disabled for fork builds, so they
cannot replace fork changes. The release includes a SHA-256 checksum, source
commit, and signing certificate information for verification.

## Windows

1. Finish active agent work and quit any running T3 Code app.
2. Run the fork's `.exe` installer and complete the installation.
3. Open **T3 Code (Nightly)** and [check the update track](#keep-receiving-fork-updates).

The build is unsigned. Windows SmartScreen may show a warning; for the installer
you downloaded from this fork, choose **More info → Run anyway** if available.

The fork uses T3 Code's existing app identity and data locations. Install over
your existing copy without deleting its data; saved threads and settings remain.
This does not create an independent profile alongside the official app.

## Linux

1. Finish active agent work and quit any running T3 Code app.
2. Download the fork's AppImage and keep it in a writable folder such as
   `~/Applications`, so the updater can replace it.
3. Make it executable and launch it. These commands assume it is initially in
   `~/Downloads`:

   ```sh
   mkdir -p "$HOME/Applications"
   mv "$HOME/Downloads/T3-Code-Nightly-x86_64.AppImage" "$HOME/Applications/"
   cd "$HOME/Applications"
   chmod +x T3-Code-Nightly-x86_64.AppImage
   ./T3-Code-Nightly-x86_64.AppImage
   ```

4. [Check the update track](#keep-receiving-fork-updates). Update any launcher you
   use so it opens this AppImage rather than an older official installation.

The fork uses the same T3 Code data as the official app. Keep that data, and run
one copy at a time.

## Keep receiving fork updates

1. Open **Settings → General → About**.
2. Set **Update track** to **Nightly**. This is the default for a fresh fork
   install, but check it when replacing an existing app.
3. Choose **Check for Updates**, then download and install the offered update.
   Let the app restart. Finish active work first because the restart can interrupt
   agents and terminal commands.

Updates come from `Alb11747/t3code`, including its upstream changes and fork
patches. **Stable** does not receive these fork nightlies. Sync follows upstream's
nightly releases (up to one every six hours); a new version appears after its
checks and builds pass. Conflicts
that need review can delay a release.

If an update fails, download the newest installer or AppImage from the same
releases page and install it manually. Check that you launched the fork copy and
kept Nightly selected. The nightly name alone does not distinguish a fork build
from an official nightly; the initial download source determines the update feed.

## Choose where agents run

To work on the computer's own files, configure its providers under **Settings →
Providers** using the [provider setup guide](../docs/user/install.md#providers).
Provider installation and sign-in happen on the machine running the agents.

To continue working on Lazarus, open **Settings → Connections**, sign in to the
same **T3 Connect** account, and select its environment. If you use direct pairing
instead, create a fresh pairing link on Lazarus and paste it into **Add environment**
on the computer. See [remote access](../docs/user/remote-access.md).

Select Lazarus for its projects and threads. Their files, history, and provider
credentials stay on Lazarus; signing in does not copy them to the computer. You do
not need local providers just to control remote agents. Lazarus must stay running
and reachable, and updating the computer app does not update Lazarus's server.

## Recovering a Claude thinking-prefix failure

When Claude rejects preserved thinking because its conversation prefix changed,
the failure row offers **Retry with dropped thinking**. This explicit retry may
run without earlier reasoning. It keeps the saved conversation, messages, tool
results, signatures and files, and continues the failed turn without resending
the original prompt. Afterwards the failure row shows a warning that the retry
dropped earlier thinking. Later turns keep their normal preservation policy, so a
later prefix mismatch may need another explicit recovery.

This action uses Claude Code's native request controls and needs no special
proxy. A gateway must forward the explicit thinking binding policy and beta
header unchanged. Authentication, quota and corrupt-signature errors do not
offer this recovery.

## Claude follow-ups during a running turn

Choose **Steer** under **Settings → General → Follow-up behavior** to send
follow-ups into the current turn. **Queue** deliberately waits for a separate
turn. The stock mobile app stores this preference on the phone and defaults to
Queue; changing the desktop preference or updating the fork server does not
change the phone's choice.

Ordinary human and agent steers, including attachments, wait for Claude's next
root tool-batch boundary and use its non-interrupting native message queue.
Parallel tools finish their batch before delivery. Questions and completion
notices from delegated tasks arrive the same way. If Claude is waiting on its
own foreground subagents when a message arrives, T3 asks Claude to move them to
the background so the message is read sooner; their results then arrive as a
background-task notice. Messages arriving during a final reply wait for the next
turn. Explicit restart still interrupts; Stop cancels pending native inputs.
Goal and maintenance commands, compaction, and turns that own a delegated task
keep their separate-turn behavior. A Claude CLI without the required
cancellation capability also waits for the next turn.

A successful MCP promotion receipt can mean the message is still waiting.
**Pending** means it is waiting for a safe boundary; **Delivering** means
Claude is taking it. Once Claude reports the message started, it leaves the
queue and appears at the tool boundary where it was inserted. If Claude drops
it unread, for example because you pressed Stop first, it returns to the queue
and waits for the next safe boundary or turn. A message that missed the last
boundary starts the next turn, ahead of messages you queued earlier. If Claude
or the server stops, or a later prompt starts, after Claude took a message but
before it reported it, the message counts as delivered and is never sent twice.

**Send now** on a Pending or Queued message during a running Claude turn
(or its keyboard shortcut) does not wait: Claude reads it at once, which can
cancel the tools it is running. Sending from the composer still waits for a
boundary, and an agent's promotion never interrupts. If the turn ends before
Claude reads the message, it stays open until Claude reads or drops it. If
Claude drops the message unread, it runs as the next turn, in its place in the
queue. If Claude or the server stops first, it waits there, held, until you
resume the queue, because it may already have reached Claude.

After a restart or crash, messages that had not reached Claude resume on their
own, in order. Messages held by Stop stay held: after Stop, an agent's message
also waits behind them until you resume the queue, and its receipt says so. An
agent can still start work at once with `mode: "restart"`.

## Browser access on macOS or other computers

To use the fork without a supported desktop build, open the web app served by a
machine running the fork. On that host, run `t3 pair` for a reachable LAN address,
or `t3 pair --tailscale` for its Tailscale HTTPS route, then open the returned
pairing URL in the computer's browser. Use a fresh link for each device; a
`127.0.0.1` URL cannot reach another machine.

The browser gets the fork's UI from that host and refreshes to its new version
after the host is updated. The public `app.t3.codes` site serves upstream's UI,
so it may not include frontend features carried only by the fork. An official
macOS desktop app also retains its upstream UI and update feed.

For the fork's maintenance and release setup, see the [fork guide](README.md).

# Install the fork on another computer

Install a build from [Alb11747/t3code releases](https://github.com/Alb11747/t3code/releases)
once, then use the app's **Install update** button for future fork releases.
You do not need to clone the repository, build anything, or set up the sync
workflow on each computer.

## Choose a download

Open the releases page and expand **Assets** on the newest published nightly.
These releases are marked **Pre-release**; use the releases list rather than
GitHub's `/releases/latest` link, which looks for a stable release.

| Computer                     | Download                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Windows, Intel or AMD 64-bit | `T3-Code-<version>-x64.exe`                                                                           |
| Linux, Intel or AMD 64-bit   | `T3-Code-<version>-x86_64.AppImage`                                                                   |
| macOS or an ARM computer     | No native fork build is published; use [browser access](#browser-access-on-macos-or-other-computers). |

The `.blockmap` and `.yml` files support automatic updates; you do not need to
download them. The `t3-...` archives are command-line servers, not desktop apps.

Official downloads, `winget`, Homebrew, `npx t3`, and the installer at `t3.codes`
install upstream T3 Code. Switching an official app to Nightly also keeps its
upstream update feed. To receive this fork's updates, install its download first.

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
3. Make it executable and launch it. Replace `VERSION` with the downloaded
   filename's version; these commands assume it is initially in `~/Downloads`:

   ```sh
   mkdir -p "$HOME/Applications"
   mv "$HOME/Downloads/T3-Code-VERSION-x86_64.AppImage" "$HOME/Applications/"
   cd "$HOME/Applications"
   chmod +x T3-Code-VERSION-x86_64.AppImage
   ./T3-Code-VERSION-x86_64.AppImage
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

## Claude follow-ups during a running turn

Choose **Steer** under **Settings → General → Follow-up behavior** to send
follow-ups into the current turn. **Queue** deliberately waits for a separate
turn. The stock mobile app stores this preference on the phone and defaults to
Queue; changing the desktop preference or updating the fork server does not
change the phone's choice.

User steers use Claude Code's native steering. The stock mobile app sends its
Steer choice as automatic delivery, so it can still become a queued next turn
while the server is starting or finishing a provider turn, even if the thread
already says Running. The server needs a live provider turn before it can steer.
This also affects short replies and background continuations. A server update
cannot change the stock app's submission behavior. Native steering itself does
not guarantee immediate model attention: Claude Code can wait for a foreground
shell call to return, and can cancel MCP calls in flight.

Agent text updates normally enter the durable queue and join Claude's current
turn at its next root tool-batch or Stop boundary, rather than waiting for the
turn to end. Agent promotions of queued text follow the same rule; human
promotions stay native. A successful MCP promotion receipt can still mean the
message is waiting. Parallel tools finish their whole batch before delivery;
the fork does not inject a context change between calls in the same batch.
There is no delivery deadline while a tool call is running. A native timeout
fallback would cancel MCP calls and could discard reasoning, so it cannot also
guarantee uninterrupted work.
Updates with attachments currently use native steering with an explanation that
another agent sent them; that explanation does not prevent cancellation.
Boundary delivery also has a crash window: an update claimed just before the
server crashes can be lost before Claude reads it. Preservation of all thinking
tokens has not been verified.

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
